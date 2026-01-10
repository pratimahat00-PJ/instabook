const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// Sample photos array (replace with DB later)
const photos = [
  { id: 1, title: "Sample Photo", url: "https://via.placeholder.com/150" },
  { id: 2, title: "My Test Photo", url: "https://via.placeholder.com/200" }
];

// Health check
app.get("/", (req, res) => res.send("SharePic API is running"));

// GET photos
app.get("/api/photos", (req, res) => {
  console.log("GET /api/photos hit!");
  res.json(photos);
});

// GET photo by ID
app.get("/api/photos/:id", (req, res) => {
  const photoId = Number(req.params.id);
  const photo = photos.find((p) => p.id === photoId);

  if (!photo) return res.status(404).json({ error: "Photo not found" });

  console.log(`GET /api/photos/${photoId} hit!`);
  res.json(photo);
});

// POST photo
app.post("/api/photos", (req, res) => {
  console.log("POST /api/photos hit! Body:", req.body);

  // safer ID generation (works even if deletions happen later)
  const newId = photos.length ? Math.max(...photos.map((p) => p.id)) + 1 : 1;

  const { title, url } = req.body;

  // basic validation (optional but recommended)
  if (!title || !url) {
    return res.status(400).json({ error: "title and url are required" });
  }

  const newPhoto = { id: newId, title, url };
  photos.push(newPhoto);

  res.status(201).json({ message: "Upload endpoint works", photo: newPhoto });
});

// POST comment
app.post("/api/photos/:id/comments", (req, res) => {
  const photoId = Number(req.params.id);
  console.log(`POST /api/photos/${photoId}/comments hit! Body:`, req.body);

  // optional: check photo exists
  const photo = photos.find((p) => p.id === photoId);
  if (!photo) return res.status(404).json({ error: "Photo not found" });

  res.status(201).json({ message: `Comment added for photo ${photoId}` });
});

// POST rating
app.post("/api/photos/:id/rating", (req, res) => {
  const photoId = Number(req.params.id);
  console.log(`POST /api/photos/${photoId}/rating hit! Body:`, req.body);

  // optional: check photo exists
  const photo = photos.find((p) => p.id === photoId);
  if (!photo) return res.status(404).json({ error: "Photo not found" });

  res.status(201).json({ message: `Rating added for photo ${photoId}` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));