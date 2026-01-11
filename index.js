const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { BlobServiceClient } = require("@azure/storage-blob");
const { CosmosClient } = require("@azure/cosmos");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;

// ------------------ CORS ------------------
const CORS_ORIGIN_RAW = process.env.CORS_ORIGIN || "*";
const ALLOWED_ORIGINS = CORS_ORIGIN_RAW.split(",").map(s => s.trim()).filter(Boolean);

app.use(express.json({ limit: "2mb" }));
app.use(
  cors({
    origin: (origin, cb) => {
      // Allow non-browser tools (postman/curl)
      if (!origin) return cb(null, true);

      // Allow all if set to *
      if (ALLOWED_ORIGINS.includes("*")) return cb(null, true);

      // Strict allow list
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);

      return cb(new Error(`CORS blocked: ${origin}`));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ------------------ MULTER ------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

// ------------------ ENV (ROBUST) ------------------
// Try multiple env names for Azure Storage connection string
const STORAGE_CONN =
  process.env.AZURE_STORAGE_CONNECTION_STRING ||
  process.env.AZURE_STORAGE_CONNECTION ||
  process.env.STORAGE_CONNECTION_STRING ||
  process.env.AZURE_STORAGE_CONN_STRING ||
  "";

// Blob container name
const BLOB_CONTAINER_NAME =
  process.env.BLOB_CONTAINER_NAME ||
  process.env.BLOB_CONTAINER ||
  "images";

// Cosmos
const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT || "";
const COSMOS_KEY = process.env.COSMOS_KEY || "";
const COSMOS_DB_NAME = process.env.COSMOS_DB_NAME || "instabookdb";

const COSMOS_PHOTOS_CONTAINER = process.env.COSMOS_PHOTOS_CONTAINER || "photos";
const COSMOS_COMMENTS_CONTAINER = process.env.COSMOS_COMMENTS_CONTAINER || "comments";
const COSMOS_RATING_CONTAINER =
  process.env.COSMOS_RATING_CONTAINER || process.env.COSMOS_RATINGS_CONTAINER || "ratings";

// ------------------ CLIENTS ------------------
const blobServiceClient = STORAGE_CONN
  ? BlobServiceClient.fromConnectionString(STORAGE_CONN)
  : null;

const cosmosClient = (COSMOS_ENDPOINT && COSMOS_KEY)
  ? new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY })
  : null;

let photosContainer;
let commentsContainer;
let ratingsContainer;

// ------------------ HELPERS ------------------
function parseCSVList(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  return String(val).split(",").map(s => s.trim()).filter(Boolean);
}

async function uploadToBlob(file) {
  if (!blobServiceClient) {
    throw new Error("Blob client not configured (missing storage connection string)");
  }

  const containerClient = blobServiceClient.getContainerClient(BLOB_CONTAINER_NAME);
  await containerClient.createIfNotExists({ access: "blob" });

  const originalName = file.originalname || "upload.jpg";
  const ext = originalName.includes(".") ? originalName.split(".").pop() : "jpg";
  const blobName = `${uuidv4()}.${ext}`;

  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  await blockBlobClient.uploadData(file.buffer, {
    blobHTTPHeaders: { blobContentType: file.mimetype || "application/octet-stream" },
  });

  return blockBlobClient.url;
}

// ------------------ INIT COSMOS ------------------
async function initCosmos() {
  if (!cosmosClient) {
    console.warn("⚠ Cosmos not configured. Check COSMOS_ENDPOINT / COSMOS_KEY.");
    return;
  }

  const { database } = await cosmosClient.databases.createIfNotExists({ id: COSMOS_DB_NAME });

  ({ container: photosContainer } = await database.containers.createIfNotExists({
    id: COSMOS_PHOTOS_CONTAINER,
    partitionKey: { paths: ["/id"] },
  }));

  ({ container: commentsContainer } = await database.containers.createIfNotExists({
    id: COSMOS_COMMENTS_CONTAINER,
    partitionKey: { paths: ["/photoId"] },
  }));

  ({ container: ratingsContainer } = await database.containers.createIfNotExists({
    id: COSMOS_RATING_CONTAINER,
    partitionKey: { paths: ["/photoId"] },
  }));

  console.log("✅ Cosmos DB ready:", COSMOS_DB_NAME);
  console.log("✅ Containers:", COSMOS_PHOTOS_CONTAINER, COSMOS_COMMENTS_CONTAINER, COSMOS_RATING_CONTAINER);
}

// ------------------ ROUTES ------------------
app.get("/", (req, res) => res.send("SharePic API is running ✅"));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    corsAllowedOrigins: ALLOWED_ORIGINS,
    blob: {
      configured: Boolean(blobServiceClient),
      container: BLOB_CONTAINER_NAME,
    },
    cosmos: {
      configured: Boolean(cosmosClient),
      db: COSMOS_DB_NAME,
      containers: {
        photos: COSMOS_PHOTOS_CONTAINER,
        comments: COSMOS_COMMENTS_CONTAINER,
        ratings: COSMOS_RATING_CONTAINER,
      },
    },
  });
});

// CREATE PHOTO (multipart file OR JSON url)
app.post("/api/photos", upload.single("image"), async (req, res) => {
  try {
    if (!photosContainer) return res.status(500).json({ error: "Cosmos not configured" });

    const title = (req.body.title || "").trim();
    if (!title) return res.status(400).json({ error: "title is required" });

    let url = (req.body.url || "").trim();

    // Prefer file upload; fallback to url
    if (req.file) {
      try {
        url = await uploadToBlob(req.file);
      } catch (blobErr) {
        return res.status(500).json({
          error: blobErr.message,
          fix: "Set AZURE_STORAGE_CONNECTION_STRING in App Service environment variables",
        });
      }
    }

    if (!url) {
      return res.status(400).json({
        error: "Provide url OR upload an image file",
        example: { title: "My photo", url: "https://example.com/photo.jpg" },
      });
    }

    const photo = {
      id: uuidv4(),
      title,
      caption: (req.body.caption || "").trim(),
      location: (req.body.location || "").trim(),
      people: parseCSVList(req.body.people),
      tags: parseCSVList(req.body.tags),
      visibility: (req.body.visibility || "public").trim(),
      url,
      createdAt: new Date().toISOString(),
    };

    await photosContainer.items.create(photo);
    res.status(201).json({ message: "Photo created", photo });
  } catch (err) {
    console.error("POST /api/photos error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// LIST/SEARCH PHOTOS
app.get("/api/photos", async (req, res) => {
  try {
    if (!photosContainer) return res.status(500).json({ error: "Cosmos not configured" });

    const q = String(req.query.q || "").trim().toLowerCase();

    const querySpec = q
      ? {
          query:
            "SELECT * FROM c WHERE " +
            "CONTAINS(LOWER(c.title), @q) OR " +
            "CONTAINS(LOWER(c.caption), @q) OR " +
            "CONTAINS(LOWER(c.location), @q) " +
            "ORDER BY c.createdAt DESC",
          parameters: [{ name: "@q", value: q }],
        }
      : { query: "SELECT * FROM c ORDER BY c.createdAt DESC" };

    const { resources } = await photosContainer.items.query(querySpec).fetchAll();
    res.json(resources);
  } catch (err) {
    console.error("GET /api/photos error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// GET PHOTO BY ID
app.get("/api/photos/:id", async (req, res) => {
  try {
    if (!photosContainer) return res.status(500).json({ error: "Cosmos not configured" });

    const id = req.params.id;
    const { resource } = await photosContainer.item(id, id).read();

    if (!resource) return res.status(404).json({ error: "Photo not found" });

    res.json(resource);
  } catch {
    res.status(404).json({ error: "Photo not found" });
  }
});

// ADD COMMENT (✅ includes authorName)
app.post("/api/photos/:id/comments", async (req, res) => {
  try {
    if (!commentsContainer) return res.status(500).json({ error: "Cosmos not configured" });

    const photoId = req.params.id;
    const authorName = (req.body.authorName || "").trim();
    const text = (req.body.text || "").trim();

    if (!authorName) return res.status(400).json({ error: "Commenter name is required" });
    if (!text) return res.status(400).json({ error: "Comment text is required" });

    const comment = {
      id: uuidv4(),
      photoId,
      authorName,
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

// GET COMMENTS
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

// ADD RATING (1–5)
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

// GET RATING SUMMARY
app.get("/api/photos/:id/rating", async (req, res) => {
  try {
    if (!ratingsContainer) return res.status(500).json({ error: "Cosmos not configured" });

    const photoId = req.params.id;

    const avgQuery = {
      query: "SELECT VALUE AVG(c.rating) FROM c WHERE c.photoId = @photoId",
      parameters: [{ name: "@photoId", value: photoId }],
    };

    const countQuery = {
      query: "SELECT VALUE COUNT(1) FROM c WHERE c.photoId = @photoId",
      parameters: [{ name: "@photoId", value: photoId }],
    };

    const avgRes = await ratingsContainer.items.query(avgQuery).fetchAll();
    const countRes = await ratingsContainer.items.query(countQuery).fetchAll();

    const average = avgRes.resources?.[0] ?? null;
    const count = countRes.resources?.[0] ?? 0;

    res.json({ photoId, average, count });
  } catch (err) {
    console.error("GET rating error:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// ------------------ START ------------------
initCosmos()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ API running on port ${PORT}`);
      console.log("✅ Allowed origins:", ALLOWED_ORIGINS);
      console.log("✅ Blob configured:", Boolean(blobServiceClient), "container:", BLOB_CONTAINER_NAME);
      console.log("✅ Cosmos configured:", Boolean(cosmosClient), "db:", COSMOS_DB_NAME);
    });
  })
  .catch((err) => {
    console.error("Init failed:", err);
    process.exit(1);
  });

