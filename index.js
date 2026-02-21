import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { v4 as uuid } from "uuid";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 5000;
const TIMEOUT_MS = 15000; // 15s
const MAX_OUT = 30000;

function normalize(s) {
  return (typeof s === "string" ? s : "").replace(/\r\n/g, "\n");
}

function truncate(s) {
  if (!s) return "";
  return s.length <= MAX_OUT ? s : s.slice(0, MAX_OUT) + "\n...output truncated";
}

function detectMainClass(code) {
  let m = code.match(/public\s+class\s+([A-Za-z_]\w*)/);
  if (m) return m[1];
  m = code.match(/class\s+([A-Za-z_]\w*)/);
  if (m) return m[1];
  return null;
}

async function writeFiles(workDir, body) {
  if (Array.isArray(body.files) && body.files.length > 0) {
    for (const f of body.files) {
      const name = String(f.name || "").trim();
      const content = normalize(f.content || "");
      if (!name.endsWith(".java")) continue;

      const fullPath = path.join(workDir, name);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, "utf8");
    }
    return;
  }

  const code = normalize(body.code || "");
  const main = detectMainClass(code);
  if (!main) throw new Error("No class found in code.");
  await fs.writeFile(path.join(workDir, `${main}.java`), code, "utf8");
}

// ✅ spawn runner (supports stdin correctly)
function runProcess(cmd, args, { cwd, timeoutMs, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true });

    let out = "";
    let err = "";
    let killedByTimeout = false;

    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill("SIGKILL");
    }, timeoutMs || TIMEOUT_MS);

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        killedByTimeout,
        stdout: out,
        stderr: err
      });
    });

    // ✅ write input to stdin (THIS is the fix)
    if (typeof input === "string" && input.length > 0) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

async function runJavaLocal({ workDir, mainClass, input }) {
  // Find all .java
  const javaFiles = [];
  async function walk(dir) {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) await walk(p);
      else if (it.isFile() && p.endsWith(".java")) javaFiles.push(p);
    }
  }
  await walk(workDir);
  if (javaFiles.length === 0) return "❌ No .java files found.";

  // ✅ compile
  const c = await runProcess("javac", ["-encoding", "UTF-8", "-d", workDir, ...javaFiles], {
    cwd: workDir,
    timeoutMs: TIMEOUT_MS
  });

  const compileOut = truncate(c.stdout + c.stderr);
  if (c.killedByTimeout) return "⏱️ Compile time limit exceeded.";
  if (c.code !== 0) return compileOut || "❌ Compile error.";

  // ✅ run (stdin works here)
  const r = await runProcess(
    "java",
    ["-Xms16m", "-Xmx256m", "-cp", workDir, mainClass],
    {
      cwd: workDir,
      timeoutMs: TIMEOUT_MS,
      input: normalize(input) + "\n"
    }
  );

  if (r.killedByTimeout) {
    // better message for Scanner users
    if (!input.trim()) {
      return "⏱️ Program waited for input. Please type input in Input box (Scanner).";
    }
    return "⏱️ Time limit exceeded (possible infinite loop).";
  }

  return truncate(r.stdout + r.stderr);
}

// -------- API --------
app.post("/run", async (req, res) => {
  const body = req.body || {};
  const input = normalize(body.input || "");

  const id = uuid();
  const workDir = path.join(os.tmpdir(), `java-run-${id}`);

  try {
    await fs.mkdir(workDir, { recursive: true });
    await writeFiles(workDir, body);

    let mainClass = String(body.mainClass || "").trim();
    if (!mainClass) {
      const code = normalize(body.code || "");
      const autoMain = detectMainClass(code);
      if (autoMain) mainClass = autoMain;
    }
    if (!mainClass) return res.json({ output: "❌ mainClass not found. Use public class Main { ... }" });

    const output = await runJavaLocal({ workDir, mainClass, input });
    res.json({ output });
  } catch (e) {
    res.status(500).json({ output: "Server error: " + (e?.message || e) });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.get("/", (req, res) => res.send("Java Compiler API ✅"));
app.listen(PORT, () => console.log(`✅ Backend running on port ${PORT}`));
