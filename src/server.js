import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());

const BASE_DIR = "/home/apps/avto-video";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPTS_DIR = path.resolve(__dirname, "..", "scripts");
const STORAGE_DIR = path.join(BASE_DIR, "storage");
const BACKEND_STORAGE_DIR = process.env.BACKEND_STORAGE_DIR || STORAGE_DIR;
const AUDIO_SRC_DIR = path.join(BACKEND_STORAGE_DIR, "audio");
const AUDIO_CAPTION_SRC_DIR = path.join(BACKEND_STORAGE_DIR, "audioCaption");
const PRODUCT_API_BASE = process.env.PRODUCT_API_BASE || "https://api.uy-joy.uz";
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

  const audioMp3Path = path.join(inputDir, "audio.mp3");
  const audioWavPath = path.join(inputDir, "audio.wav");
  const captionsPath = path.join(inputDir, "captions.srt");
  const outVideo = path.join(outputDir, "video.mp4");

  const outRel = `videos/${id}/output/video.mp4`;

  return {
    id,
    jobDir,
    inputDir,
    imagesDir,
    outputDir,
    lockPath,
    statusPath,
    errorPath,
    audioMp3Path,
    audioWavPath,
    captionsPath,
    outVideo,
    outRel
  };
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
  const audioPath = fs.existsSync(p.audioMp3Path) ? p.audioMp3Path : p.audioWavPath;

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
    path.join(SCRIPTS_DIR, "render_video.py"),
    "--images-dir", p.imagesDir,
    "--audio-path", audioPath,
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

function extractImageUrls(payload) {
  if (!payload || typeof payload !== "object") return [];
  const root = payload?.data || payload?.result || payload;
  const candidates = [
    root?.photos,
    root?.images,
    root?.productOrder?.photos,
    root?.product?.photos,
    root?.productOrder?.product?.photos
  ];
  const singles = [
    root?.photo,
    root?.productOrder?.photo,
    root?.product?.photo
  ];

  const out = [];
  const seen = new Set();
  const addUrl = (value) => {
    const v = String(value || "").trim();
    if (!v) return;
    const abs = normalizeImageUrl(v);
    if (!abs) return;
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push(abs);
  };

  const normalizeEntry = (entry) => {
    if (!entry) return "";
    if (typeof entry === "string") return entry;
    return entry?.url || entry?.imageUrl || entry?.src || entry?.path || entry?.fileUrl || "";
  };

  candidates.forEach((list) => {
    if (!Array.isArray(list)) return;
    list.forEach((entry) => addUrl(normalizeEntry(entry)));
  });
  singles.forEach((entry) => addUrl(normalizeEntry(entry)));

  return out;
}

function normalizeImageUrl(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith("//")) return `https:${v}`;
  if (v.startsWith("/")) {
    try {
      const base = new URL(PRODUCT_API_BASE);
      return `${base.origin}${v}`;
    } catch {
      return `${PRODUCT_API_BASE.replace(/\/$/, "")}${v}`;
    }
  }
  return v;
}

async function fetchProduct(productId) {
  const url = `${PRODUCT_API_BASE.replace(/\/$/, "")}/api/public/product/${productId}`;
  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(t || `Product API xatosi: ${resp.status}`);
  }
  return resp.json();
}

async function downloadImageToDir(url, dir, index) {
  const resp = await fetch(url, { method: "GET" });
  if (!resp.ok) {
    throw new Error(`Rasmni yuklab bo'lmadi: ${resp.status}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  let ext = "";
  try {
    const u = new URL(url);
    ext = path.extname(u.pathname || "");
  } catch {}
  if (!ext || ext.length > 5) {
    const ct = String(resp.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("png")) ext = ".png";
    else if (ct.includes("webp")) ext = ".webp";
    else if (ct.includes("jpeg") || ct.includes("jpg")) ext = ".jpg";
    else ext = ".jpg";
  }
  const name = String(index + 1).padStart(3, "0") + ext;
  const dest = path.join(dir, name);
  fs.writeFileSync(dest, buf);
  return dest;
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
  async (req, res) => {
    const productId = String(req.body.productId || "").trim();
    if (!productId) return res.status(400).json({ ok: false, error: "productId required" });

    const p = jobPaths(productId);
    ensureDir(p.imagesDir);
    ensureDir(p.outputDir);

    // Agar video tayyor bo‘lsa, qayta render qilmaymiz
    const st0 = getStatus(productId);
    if (st0.status === "done") return res.json({ ok: true, ...st0 });
    if (st0.status === "running") return res.json({ ok: true, ...st0 });

    const audio = req.files?.audio?.[0];
    const captions = req.files?.captions?.[0];
    const images = req.files?.images || [];
    const hasUploads = Boolean(audio || captions || images.length);

    if (audio) {
      fs.writeFileSync(p.audioMp3Path, audio.buffer);
    } else {
      const srcAudio = path.join(AUDIO_SRC_DIR, `${productId}_audio.mp3`);
      if (!fs.existsSync(srcAudio)) {
        return res.status(404).json({ ok: false, error: "Audio topilmadi" });
      }
      fs.copyFileSync(srcAudio, p.audioMp3Path);
    }

    if (captions) {
      fs.writeFileSync(p.captionsPath, captions.buffer);
    } else {
      const srcCaption = path.join(AUDIO_CAPTION_SRC_DIR, `${productId}_audioCaption.srt`);
      if (fs.existsSync(srcCaption)) {
        fs.copyFileSync(srcCaption, p.captionsPath);
      } else {
        try { fs.unlinkSync(p.captionsPath); } catch {}
      }
    }

    // eski rasmlarni tozalash
    for (const f of fs.readdirSync(p.imagesDir)) {
      fs.unlinkSync(path.join(p.imagesDir, f));
    }

    if (images.length) {
      const sorted = images.slice().sort((a, b) => a.originalname.localeCompare(b.originalname));
      sorted.forEach((img, idx) => {
        const ext = path.extname(img.originalname) || ".jpg";
        const name = String(idx + 1).padStart(3, "0") + ext.toLowerCase();
        fs.writeFileSync(path.join(p.imagesDir, name), img.buffer);
      });
    } else if (!hasUploads || !images.length) {
      try {
        const product = await fetchProduct(productId);
        const urls = extractImageUrls(product);
        if (!urls.length) {
          return res.status(404).json({ ok: false, error: "Rasmlar topilmadi" });
        }
        for (let i = 0; i < urls.length; i += 1) {
          await downloadImageToDir(urls[i], p.imagesDir, i);
        }
      } catch (err) {
        return res.status(502).json({ ok: false, error: err?.message || "Rasmlarni olishda xatolik" });
      }
    }

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
