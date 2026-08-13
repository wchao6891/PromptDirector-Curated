import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeSiteMediaManifest } from "./curated-site-data.mjs";

const API_VERSION = "2022-11-28";

export async function publishMediaRelease({ catalogPath, manifestPath, mediaRoot, repository, packageId, token = "" }) {
  const repositoryName = normalizeRepository(repository);
  token ||= process.env.GH_TOKEN || (await commandOutput("gh", ["auth", "token"])).trim();
  if (!token) throw new Error("GitHub 登录不可用，未执行任何 GitHub 变更");
  const catalogValue = JSON.parse(await readFile(resolve(catalogPath), "utf8"));
  const manifest = normalizeSiteMediaManifest(JSON.parse(await readFile(resolve(manifestPath), "utf8")), catalogValue);
  const mediaPackage = manifest.packages.find((item) => item.packageId === packageId);
  if (!mediaPackage) throw new Error(`媒体清单中不存在包：${packageId}`);
  const packageRoot = resolve(mediaRoot, mediaPackage.packageId);

  await apiRequest(`https://api.github.com/repos/${repositoryName}/immutable-releases`, { method: "PUT", token, expected: [204] });
  const existing = await apiRequest(`https://api.github.com/repos/${repositoryName}/releases/tags/${encodeURIComponent(mediaPackage.releaseTag)}`, { token, expected: [200, 404] });
  if (existing.status === 200 && !existing.json?.draft) throw new Error(`已发布的 Release 不允许修改：${mediaPackage.releaseTag}`);
  const release = existing.status === 200 ? existing.json : (await apiRequest(`https://api.github.com/repos/${repositoryName}/releases`, {
    method: "POST",
    token,
    expected: [201],
    body: {
      tag_name: mediaPackage.releaseTag,
      name: `${mediaPackage.packageId} ${mediaPackage.packageVersion} media`,
      draft: true,
      prerelease: false,
      generate_release_notes: false
    }
  })).json;
  const uploaded = [];
  try {
    const expectedNames = new Set([...mediaPackage.entries.map((entry) => `${entry.videoSha256}.mp4`), "media-manifest.json"]);
    if ((release.assets ?? []).some((asset) => !expectedNames.has(asset.name))) throw new Error("草稿 Release 包含计划外资产");
    const existingAssets = new Map((release.assets ?? []).map((asset) => [asset.name, asset]));
    for (const entry of mediaPackage.entries) {
      const fileName = `${entry.videoSha256}.mp4`;
      uploaded.push(await uploadAsset({ repositoryName, releaseId: release.id, path: join(packageRoot, fileName), fileName, contentType: entry.videoMimeType, expectedSha256: entry.videoSha256, expectedBytes: entry.videoBytes, existingAsset: existingAssets.get(fileName), token }));
    }
    const packageManifestPath = join(packageRoot, "media-manifest.json");
    uploaded.push(await uploadAsset({ repositoryName, releaseId: release.id, path: packageManifestPath, fileName: "media-manifest.json", contentType: "application/json", existingAsset: existingAssets.get("media-manifest.json"), token }));
    for (const asset of uploaded.filter((item) => item.contentType === "video/mp4")) {
      await verifyStreamResponse(asset.apiUrl, { token, authenticated: true });
    }
    const published = await apiRequest(`https://api.github.com/repos/${repositoryName}/releases/${release.id}`, {
      method: "PATCH",
      token,
      expected: [200],
      body: { draft: false }
    });
    if (!published.json?.immutable) throw new Error("Release 已发布，但 GitHub 未返回 immutable=true；停止后续包发布");
    for (const entry of mediaPackage.entries) await verifyStreamResponse(entry.videoUrl, { authenticated: false });
    return { packageId: mediaPackage.packageId, releaseTag: mediaPackage.releaseTag, releaseUrl: published.json.html_url, assetCount: uploaded.length, immutable: true };
  } catch (error) {
    throw new Error(`媒体 Release ${mediaPackage.releaseTag} 未完成：${error.message}`);
  }
}

function commandOutput(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolvePromise(Buffer.concat(stdout).toString("utf8"))
      : reject(new Error(`${command} 失败 (${code})：${Buffer.concat(stderr).toString("utf8").trim()}`)));
  });
}

async function uploadAsset({ repositoryName, releaseId, path, fileName, contentType, expectedSha256 = "", expectedBytes = 0, existingAsset, token }) {
  const bytes = await readFile(path);
  const info = await stat(path);
  if (!info.isFile() || bytes.byteLength !== info.size) throw new Error(`待发布文件不可读：${fileName}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (expectedSha256 && sha256 !== expectedSha256) throw new Error(`${fileName} 的本地摘要变化`);
  if (expectedBytes && bytes.byteLength !== expectedBytes) throw new Error(`${fileName} 的本地大小变化`);
  const asset = existingAsset ?? (await apiRequest(`https://uploads.github.com/repos/${repositoryName}/releases/${releaseId}/assets?name=${encodeURIComponent(fileName)}`, {
      method: "POST",
      token,
      expected: [201],
      headers: { "Content-Type": contentType },
      rawBody: bytes
    })).json;
  if (asset.size !== bytes.byteLength || asset.digest !== `sha256:${sha256}` || asset.content_type !== contentType || !asset.url) {
    throw new Error(`${fileName} 的 GitHub Asset 大小或摘要不一致`);
  }
  return { apiUrl: asset.url, browserUrl: asset.browser_download_url, contentType, sha256, bytes: bytes.byteLength };
}

async function verifyStreamResponse(url, { token = "", authenticated }) {
  const headers = { Range: "bytes=0-1" };
  if (authenticated) {
    headers.Authorization = `Bearer ${token}`;
    headers.Accept = "application/octet-stream";
    headers["X-GitHub-Api-Version"] = API_VERSION;
  }
  const response = await fetch(url, { headers, redirect: "follow", credentials: "omit", cache: "no-store" });
  await response.body?.cancel();
  const responseType = response.headers.get("content-type")?.split(";")[0].trim();
  const acceptedTypes = new Set(["video/mp4", "application/octet-stream"]);
  if (response.status !== 206 || !acceptedTypes.has(responseType) || response.headers.get("accept-ranges")?.toLowerCase() !== "bytes") {
    throw new Error(`视频流验证失败（HTTP ${response.status}）`);
  }
}

async function apiRequest(url, { method = "GET", token, expected, body, rawBody, headers = {} }) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "PromptDirector-Curated-Publisher",
      ...headers
    },
    body: rawBody ?? (body ? JSON.stringify(body) : undefined)
  });
  const text = response.status === 204 ? "" : await response.text();
  let json = null;
  if (text) {
    try { json = JSON.parse(text); } catch { json = null; }
  }
  if (!expected.includes(response.status)) throw new Error(`GitHub API 请求失败（HTTP ${response.status}）：${json?.message ?? "无可用错误详情"}`);
  return { status: response.status, json };
}

function normalizeRepository(value) {
  const repository = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("GitHub 仓库必须是 owner/repo");
  return repository;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [catalogPath, manifestPath, mediaRoot, repository, packageId] = process.argv.slice(2);
  if (!catalogPath || !manifestPath || !mediaRoot || !repository || !packageId) {
    throw new Error("用法：GH_TOKEN=... node tools/publish-media-release.mjs <catalog.json> <媒体清单> <媒体目录> <owner/repo> <packageId>");
  }
  const result = await publishMediaRelease({ catalogPath, manifestPath, mediaRoot, repository, packageId });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
