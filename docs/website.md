# Brand website

The website uses the same reviewed content in `site/` as the existing curated site. `web/` contains the new interface and translations. There is no second catalog to maintain.

## Build and preview

Use Node.js 22 or newer. Install the locked build dependencies first.

```sh
npm ci
node tools/build-website.mjs
npm test
python3 -m http.server 8768 --bind 127.0.0.1 --directory dist/website
```

Open `/index.html?lang=zh-CN` or `/en/index.html`. The build output `dist/website` is suitable for a static host. `web/config.json` defines the public origin, existing asset origin, contact information and featured case. The public website is [promptdirector.cn](https://promptdirector.cn/); building locally does not deploy changes.

## Publishing one content source

Continue publishing reviewed packages, previews, Skills and metrics into `site/`. The current GitHub Pages workflow continues to publish `site/` for old extension versions. A second static deployment builds `dist/website` from the same revision. Configure its build command as `node tools/build-website.mjs` and output directory as `dist/website`. A host must support the site's actual file sizes; verify its limits before choosing or connecting it.

The website checks run on pull requests and content changes. They do not deploy. See [Cloudflare build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/) and [GitHub custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) for the hosting interfaces; neither service's settings are changed by this code.

Existing catalog/preview/media/download URLs must keep responding directly while old extension versions depend on them. Do not add a CNAME or global redirect to the legacy deployment. New output contains its own media, preview and document resources. GitHub Release downloads retain their existing identities and download metrics.

## Data and behavior

- The initial index contains titles, attribution, thumbnails, media types and stable IDs. Every prerendered visible case includes its complete original content in HTML; other cases load one detail file on demand. Full-text search loads its separate text index. Failures remain retryable.
- HTML is prerendered at build time (with homepage styles embedded to avoid a blocking stylesheet request), so visitors and crawlers can read the first screen without downloading the full catalog. Each collection, case, Skill and contributor has a stable, bilingual page with canonical metadata and sitemap discovery. Existing query URLs remain supported.
- Responsive WebP card images are separate from original detail previews and downloads. Build caching uses existing Git object IDs; generated image URLs can be cached immutably.
- Website videos prefer a separate smooth preview when available and offer Original quality. Switching quality preserves playback position and pause state. Original media fields, legacy resources and package downloads are never replaced with derivatives.
- Page scripts and styles use content-versioned URLs, so returning visitors receive matching code after a deployment while unchanged assets remain cacheable.
- A case URL uses the catalog ID and original entry ID, never its list position. Compound cases retain all member media, full prompt text and per-member sources.
- Package type is derived from case media types. A video poster is not an image case. A mixed compound appears in both filters.
- Default sorting uses first publication, not later edits. `web/publication-dates.json` preserves the first catalog appearance of existing packages from Git history. New entries may supply `publishedAt`; otherwise a complete Git history determines their first appearance. Shallow builds with unknown dates fail rather than invent dates. Use `fetch-depth: 0` in CI. English display metadata is maintained in `web/catalog-translations-en.json`; publishing must add translations for new IDs (the website tests report gaps).
- The UI source is shared. The build generates English assets from `web/ui-en.json`; generated assets are not hand-edited. Original prompts, author attribution and downloadable documents keep their original language.
- Follows remain device-local under the existing storage key. Both websites provide `following.html` to export/import a following list and language choice. Import merges with existing follows; it never clears them. No account synchronization is implied.
- Submissions continue through the existing GitHub review workflow. The site does not pretend to provide a file-upload service.

## Cutover checks

Before production deployment: verify actual domain hosting and HTTPS, file-size/bandwidth limits, video playback, current and old extension catalog/preview/package import, and the store's privacy/support links. New extension URLs and host permissions are a separate release. Retire the old deployment only after stored media references, follows, shared links and supported extension versions have a verified migration path.

## Website playback previews

`web/video-previews.json` maps existing original video identifiers to website-only derivatives. `web/video-profile.json` defines the smooth-playback budget: a maximum 1280-pixel edge, at most 30 fps, H.264 at about 1.2 Mbps and AAC at 96 kbps. Originals already within that budget are retained without recompression; derivatives larger than their originals are discarded.

With FFmpeg and curl installed, run `tools/prepare-website-videos.mjs` with `--output=YOUR_CACHE_DIRECTORY` and `--release-base=YOUR_NEW_GITHUB_RELEASE_ASSET_BASE`. It resumes its receipt, validates duration and dimensions, and writes `video-previews.json`. The default encoder is portable libx264; `--encoder=h264_videotoolbox` uses macOS hardware encoding. Temporary downloaded copies are removed after processing; reviewed source files are not written. Upload completed derivatives to a new website-only Release, verify the asset names and sizes, then copy the generated manifest into `web/` and rebuild. Do not overwrite original assets or previously published derivatives.

The Pages build generates `_worker.js` and `_routes.json`. Only `/website/video/*` invokes a Function; all other traffic stays static. The Function resolves an allowlisted GitHub Release redirect with HEAD, then sends the browser directly to the signed file URL. It never proxies video bytes. Signed redirects use `no-store` to avoid expiry failures. A failed lookup falls back to the selected public Release URL; a player load failure can retry the original. Static-only local servers lack this helper and may fall back to original playback; test smooth playback on a Pages preview deployment before production.

## Cloudflare Pages deployment

The `promptdirector` Pages project deploys this repository's `main` branch to [promptdirector.pages.dev](https://promptdirector.pages.dev/). Its custom domain is [promptdirector.cn](https://promptdirector.cn/). The existing GitHub Pages project retains its original address and domain settings for current extensions.

| Setting | Value |
| --- | --- |
| Framework | None |
| Production branch | `main` |
| Build command | `if [ "$(git rev-parse --is-shallow-repository)" = true ]; then git fetch --unshallow; fi && node tools/build-website.mjs` |
| Build output | `dist/website` |
| Node.js | 22 or newer |

The publication-date builder requires complete Git history for newly introduced packages without explicit `publishedAt`; the build command fetches it when needed. Verify preview deployments before publishing changes. Skill translations use stable `skillId` keys, so a package version change preserves its display translation while download identities and URLs come from the current reviewed catalog. Update the English wording whenever a method's displayed meaning changes.

Add `promptdirector.cn` to the same Cloudflare account, copy and verify its existing DNS records, then change the authoritative nameservers at the domain registrar to the pair assigned by Cloudflare. This does not transfer domain registration. Add the domain through the Pages project's Custom domains screen and wait for DNS and HTTPS activation. Preserve mail and other existing service records. Do not use a CNAME on the legacy GitHub Pages deployment.

Current platform requirements and steps: [Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/), [custom apex domains](https://developers.cloudflare.com/pages/configuration/custom-domains/), [file and build limits](https://developers.cloudflare.com/pages/platform/limits/). Recheck the generated site's file count and largest file before deployment; large future media may need separate hosting. Test actual visitor-network access and media playback before making the new site the official entry point.
