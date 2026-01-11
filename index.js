const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { BlobServiceClient } = require("@azure/storage-blob");
const { CosmosClient } = require("@azure/cosmos");
const { v4: uuidv4 } = require("uuid");

const app = express();

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;

// Blob
const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const BLOB_CONTAINER_NAME = process.env.BLOB_CONTAINER_NAME || "images";

// Cosmos
const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT;
const COSMOS_KEY = process.env.COSMOS_KEY;
const COSMOS_DB_NAME = process.env.COSMOS_DB_NAME || "instabookdb";

// Container names (use env if you add them; otherwise defaults)
const COSMOS_PHOTOS_CONTAINER = process.env.COSMOS_PHOTOS_CONTAINER || "photos";
const COSMOS_COMMENTS_CONTAINER = process.env.COSMOS_COMMENTS_CONTAINER || "comments";
const COSMOS_RATING_CONTAINER = process.env.COSMOS_RATING_CONTAINER || "ratings";

// CORS
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

// ---------- MIDDLEWARE ----------
app.use(express.json({ limit: "2mb" }));

app.use(
  cors({
    origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Multer (memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

// ---------- CLIENTS ----------
function requireEnv(name, value) {
  if (!value) {
    console.error(`Missing env var: ${name}`);
  }
}

requireEnv("AZURE_STORAGE_CONNECTION_STRING", AZURE_STORAGE_CONNECTION_STRING);
requireEnv("COSMOS_ENDPOINT", COSMOS_ENDPOINT);
requireEnv("COSMOS_KEY", COSMOS_KEY);

const blobServiceClient = AZURE_STORAGE_CONNECTION_STRING
  ? BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING)
  : null;

const cosmosClient = (COSMOS_ENDPOINT && COSMOS_KEY)
  ? new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY })
  : null;

let db, photosContainer, commentsContainer, ratingsContainer;

// ---------- INIT COSMOS/CONTAINERS ----------
async function init() {
  if (!cosmosClient) return;

  const { database } = await cosmosClient.databases.createIfNotExists({ id: COSMOS_DB_NAME });
  db = database;

  // Partition key choices:
  // photos: /id (simple for small projects)
  // comments: /photoId (good distribution)
  // ratings: /photoId (good distribution)
  ({ container: photosContainer } = await db.containers.createIfNotExists({
    id: COSMOS_PHOTOS_CONTAINER,
    partitionKey: { paths: ["/id"] },
  }));

  ({ container: commentsContainer } = await db.containers.createIfNotExists({
    id: COSMOS_COMMENTS_CONTAINER,
    partitionKey: { paths: ["/photoId"] },
  }));

  ({ container: ratingsContainer } = await db.containers.createIfNotExists({
    id: COSMOS_RATING_CONTAINER,
    partitionKey: { paths: ["/photoId"] },
  }));

  // Optional index policy defaults are fine for coursework.
  console.log("Cosmos DB ready:", COSMOS_DB_NAME);
}

// ---------- HELPERS ----------
async function uploadToBlob(fileBuffer, originalName, mimeType) {
  if (!blobServiceClient) throw new Error("Blob client not configured");

  const containerClient = blobServiceClient.getContainerClient(BLOB_CONTAINER_NAME);
  await containerClient.createIfNotExists({ access: "blob" });

  const ext = (originalName || "image").split(".").pop();
  const blobName = `${uuidv4()}.${ext}`;
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  await blockBlobClient.uploadData(fileBuffer, {
    blobHTTPHeaders: { blobContentType: mimeType || "application/octet-stream" },
  });

  return blockBlobClient.url;
}

function parseCSVList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------- ROUTES ----------
app.get("/", (req, res) => res.send("SharePic API is running ✅"));

// Create photo (supports multipart upload OR JSON with url)
app.post("/api/photos", upload.single("image"), async (req, res) => {
  try {
    if (!photosContainer) return res.status(500).json({ error: "Cosmos not configured" });

    const title = (req.body.title || "").trim();
    if (!title) return res.status(400).json({ error: "title is required" });

    let url = (req.body.url || "").trim();

    // If file upload is provided, upload to Blob
    if (req.file) {
      url = await uploadToBlob(req.file.buffer, req.file.originalname, req.file.mimetype);
    }

    if (!url) return res.status(400).json({ error: "Provide url OR upload an image file" });

    const now = new Date().toISOString();
    const photo = {
      id: uuidv4(),
      title,
      caption: (req.body.caption || "").trim(),
      location: (req.body.location || "").trim(),
      people: parseCSVList(req.body.people),
      tags: parseCSVList(req.body.tags),
      visibility: (req.body.visibility || "public").trim(),
      url,
      createdAt: now,
    };

    await photosContainer.items.create(photo);
    res.status(201).json({ message: "Photo created", photo });
  } catch (err) {
    console.error("POST /api/photos error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// List/search photos: /api/photos?q=...
app.get("/api/photos", async (req, res) => {
  try {
    if (!photosContainer) return res.status(500).json({ error: "Cosmos not configured" });

    const q = (req.query.q || "").trim().toLowerCase();

    // Cosmos SQL search using CONTAINS (simple + good for coursework)
    let querySpec;
    if (q) {
      querySpec = {
        query:
          "SELECT * FROM c WHERE " +
          "CONTAINS(LOWER(c.title), @q) OR " +
          "CONTAINS(LOWER(c.caption), @q) OR " +
          "CONTAINS(LOWER(c.location), @q) " +
          "ORDER BY c.createdAt DESC",
        parameters: [{ name: "@q", value: q }],
      };
    } else {
      querySpec = {
        query: "SELECT * FROM c ORDER BY c.createdAt DESC",
      };
    }

    const { resources } = await photosContainer.items.query(querySpec).fetchAll();
    res.json(resources);
  } catch (err) {
    console.error("GET /api/photos error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// Get photo by id
app.get("/api/photos/:id", async (req, res) => {
  try {
    if (!photosContainer) return res.status(500).json({ error: "Cosmos not configured" });

    const id = req.params.id;
    const { resource } = await photosContainer.item(id, id).read();
    if (!resource) return res.status(404).json({ error: "Photo not found" });

    res.json(resource);
  } catch (err) {
    console.error("GET /api/photos/:id error:", err);
    res.status(404).json({ error: "Photo not found" });
  }
});

// Add comment
app.post("/api/photos/:id/comments", async (req, res) => {
  try {
    if (!commentsContainer) return res.status(500).json({ error: "Cosmos not configured" });

    const photoId = req.params.id;
    const text = (req.body.text || "").trim();
    if (!text) return res.status(400).json({ error: "text is required" });

    const comment = {
      id: uuidv4(),
      photoId,
      text,
      createdAt: new Date().toISOString(),
    };

    await commentsContainer.items.create(comment);
    res.status(201).json({ message: "Comment added", comment });
  } catch (err) {
    console.error("POST comment error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// Get comments (latest first)
app.get("/api/photos/:id/comments", async (req, res) => {
  try {
    if (!commentsContainer) return res.status(500).json({ error: "Cosmos not configured" });

    const photoId = req.params.id;
    const querySpec = {
      query: "SELECT * FROM c WHERE c.photoId = @photoId ORDER BY c.createdAt DESC",
      parameters: [{ name: "@photoId", value: photoId }],
    };

    const { resources } = await commentsContainer.items.query(querySpec).fetchAll();
    res.json(resources);
  } catch (err) {
    console.error("GET comments error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// Add rating (1-5)
app.post("/api/photos/:id/rating", async (req, res) => {
  try {
    if (!ratingsContainer) return res.status(500).json({ error: "Cosmos not configured" });

    const photoId = req.params.id;
    const rating = Number(req.body.rating);

    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: "rating must be between 1 and 5" });
    }

    const ratingDoc = {
      id: uuidv4(),
      photoId,
      rating,
      createdAt: new Date().toISOString(),
    };

    await ratingsContainer.items.create(ratingDoc);
    res.status(201).json({ message: "Rating saved", rating: ratingDoc });
  } catch (err) {
    console.error("POST rating error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// Get rating summary
app.get("/api/photos/:id/rating", async (req, res) => {
  try {
    if (!ratingsContainer) return res.status(500).json({ error: "Cosmos not configured" });

    const photoId = req.params.id;

    const querySpec = {
      query: "SELECT VALUE AVG(c.rating) FROM c WHERE c.photoId = @photoId",
      parameters: [{ name: "@photoId", value: photoId }],
    };
    const countSpec = {
      query: "SELECT VALUE COUNT(1) FROM c WHERE c.photoId = @photoId",
      parameters: [{ name: "@photoId", value: photoId }],
    };

    const avgRes = await ratingsContainer.items.query(querySpec).fetchAll();
    const countRes = await ratingsContainer.items.query(countSpec).fetchAll();

    const avg = avgRes.resources?.[0] ?? null;
    const count = countRes.resources?.[0] ?? 0;

    res.json({ photoId, average: avg, count });
  } catch (err) {
    console.error("GET rating error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// ---------- START ----------
init()
  .then(() => {
    app.listen(PORT, () => console.log(`API running on port ${PORT}`));
  })
  .catch((err) => {
    console.error("Init failed:", err);
    process.exit(1);
  });
