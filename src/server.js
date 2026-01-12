import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const app = express();
app.use(express.json());

const BASE_DIR = "/home/apps/avto-video";
const STORAGE_DIR = path.join(BASE_DIR, "storage");
const VIDEOS_DIR = path.join(STORAGE_DIR, "videos");
const ASSETS_DIR = path.join(BASE_DIR, "assets");

// Sizning domeningiz (Nginx /files/ -> storage/ qilib bergan bo‘lsa):
const PUBLIC_BASE_URL = "https://video-backend.webpack.uz";
const publicFileUrl = (rel) => `${PUBLIC_BASE_URL}/files/${rel.replace(/\\/g, "/")}`;

// upload limit (xohlasangiz oshiring)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 300 * 1024 * 1024 } // 300MB
});

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function jobPaths(productId) {
  const id = String(productId);
  const jobDir = path.join(VIDEOS_DIR, id);
  const inputDir = path.join(jobDir, "input");
  const imagesDir = path.join(inputDir, "images");
  const outputDir = path.join(jobDir, "output");
  const lockPath = path.join(jobDir, ".lock");
  const statusPath = path.join(jobDir, "status.json");
  const errorPath = path.join(jobDir, "error.txt");

  const audioPath = path.join(inputDir, "audio.wav");
  const captionsPath = path.join(inputDir, "captions.srt");
  const outVideo = path.join(outputDir, "video.mp4");

  const outRel = `videos/${id}/output/video.mp4`;

  return { id, jobDir, inputDir, imagesDir, outputDir, lockPath, statusPath, errorPath, audioPath, captionsPath, outVideo, outRel };
}

function writeStatus(p, statusObj) {
  fs.writeFileSync(p.statusPath, JSON.stringify(statusObj, null, 2));
}

function readStatus(p) {
  try { return JSON.parse(fs.readFileSync(p.statusPath, "utf-8")); } catch { return null; }
}

// Atomik lock: agar mavjud bo‘lsa, ikkinchi render boshlanmaydi
function tryAcquireLock(lockPath) {
  try {
    const fd = fs.openSync(lockPath, "wx"); // fail if exists
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function releaseLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch {}
}

function getStatus(productId) {
  const p = jobPaths(productId);

  if (fs.existsSync(p.outVideo)) {
    return { status: "done", productId: p.id, fileUrl: publicFileUrl(p.outRel) };
  }
  if (fs.existsSync(p.errorPath)) {
    const err = fs.readFileSync(p.errorPath, "utf-8").slice(0, 8000);
    return { status: "failed", productId: p.id, error: err };
  }
  if (fs.existsSync(p.lockPath)) {
    return { status: "running", productId: p.id };
  }
  const st = readStatus(p);
  if (st?.status) return { status: st.status, productId: p.id };
  return { status: "not_found", productId: p.id };
}

function startRender(productId) {
  const p = jobPaths(productId);

  // video allaqachon tayyor
  if (fs.existsSync(p.outVideo)) return { started: false, status: "done" };
  // render ketmoqda
  if (fs.existsSync(p.lockPath)) return { started: false, status: "running" };

  ensureDir(p.imagesDir);
  ensureDir(p.outputDir);

  // lock olish (atomik)
  if (!tryAcquireLock(p.lockPath)) {
    return { started: false, status: "running" };
  }

  // status
  writeStatus(p, { status: "running", startedAt: new Date().toISOString() });
  try { fs.unlinkSync(p.errorPath); } catch {}

  const args = [
    path.join(BASE_DIR, "scripts", "render_video.py"),
    "--images-dir", p.imagesDir,
    "--audio-path", p.audioPath,
    "--output-path", p.outVideo,
    "--assets-dir", ASSETS_DIR
  ];

  // captions bo‘lsa qo‘shamiz
  if (fs.existsSync(p.captionsPath)) {
    args.push("--captions-path", p.captionsPath);
  }

  const py = spawn("python3", args, { stdio: ["ignore", "ignore", "pipe"] });

  let stderr = "";
  py.stderr.on("data", (d) => { stderr += d.toString(); });

  py.on("close", (code) => {
    if (code === 0 && fs.existsSync(p.outVideo)) {
      writeStatus(p, {
        status: "done",
        finishedAt: new Date().toISOString(),
        fileUrl: publicFileUrl(p.outRel)
      });
      releaseLock(p.lockPath);
      return;
    }

    const msg = stderr || `Render failed with exit code ${code}`;
    fs.writeFileSync(p.errorPath, msg);
    writeStatus(p, { status: "failed", finishedAt: new Date().toISOString() });
    releaseLock(p.lockPath);
  });

  return { started: true, status: "running" };
}

app.get("/health", (_, res) => res.json({ ok: true }));

// STATUS
app.get("/api/video/status/:productId", (req, res) => {
  const productId = String(req.params.productId || "").trim();
  if (!productId) return res.status(400).json({ ok: false, error: "productId required" });
  return res.json({ ok: true, ...getStatus(productId) });
});

// RENDER (idempotent)
app.post(
  "/api/video/render",
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "captions", maxCount: 1 },
    { name: "images", maxCount: 100 }
  ]),
  (req, res) => {
    const productId = String(req.body.productId || "").trim();
    if (!productId) return res.status(400).json({ ok: false, error: "productId required" });

    const p = jobPaths(productId);
    ensureDir(p.imagesDir);
    ensureDir(p.outputDir);

    // Agar video tayyor bo‘lsa, qayta render qilmaymiz
    const st0 = getStatus(productId);
    if (st0.status === "done") return res.json({ ok: true, ...st0 });
    if (st0.status === "running") return res.json({ ok: true, ...st0 });

    // audio majburiy (siz xohlasangiz optional qilamiz)
    const audio = req.files?.audio?.[0];
    if (!audio) return res.status(400).json({ ok: false, error: "audio required" });
    fs.writeFileSync(p.audioPath, audio.buffer);

    // captions ixtiyoriy
    const captions = req.files?.captions?.[0];
    if (captions) {
      fs.writeFileSync(p.captionsPath, captions.buffer);
    } else {
      try { fs.unlinkSync(p.captionsPath); } catch {}
    }

    // images majburiy
    const images = req.files?.images || [];
    if (!images.length) return res.status(400).json({ ok: false, error: "images[] required" });

    // eski rasmlarni tozalash
    for (const f of fs.readdirSync(p.imagesDir)) {
      fs.unlinkSync(path.join(p.imagesDir, f));
    }

    // ketma-ket saqlaymiz: 001.jpg, 002.jpg ...
    const sorted = images.slice().sort((a, b) => a.originalname.localeCompare(b.originalname));
    sorted.forEach((img, idx) => {
      const ext = path.extname(img.originalname) || ".jpg";
      const name = String(idx + 1).padStart(3, "0") + ext.toLowerCase();
      fs.writeFileSync(path.join(p.imagesDir, name), img.buffer);
    });

    // Render boshlaymiz
    const r = startRender(productId);
    const st1 = getStatus(productId);

    // started bo‘lsa ham, status running qaytamiz
    return res.json({ ok: true, status: st1.status === "done" ? "done" : "running", productId, ...(st1.status === "done" ? { fileUrl: st1.fileUrl } : {}) });
  }
);

const PORT = process.env.PORT || 4000;
ensureDir(VIDEOS_DIR);

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Backend running on http://127.0.0.1:${PORT}`);
});
