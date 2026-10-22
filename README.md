# PromptDirector Curated

**English** · [简体中文](README.zh-CN.md)

**2,000+ visual cases and reusable creative Skills.** Start with the work, then explore its prompt and source. Browse visual references collected and reviewed with PromptDirector. No installation is needed to explore; download a pack when you want to keep it in your own local library.

[Browse curated cases](https://promptdirector.cn/en/) · [Curated Skills](https://promptdirector.cn/en/skills/) · [Quick start](https://promptdirector.cn/en/guide.html) · [Add to Chrome](https://chromewebstore.google.com/detail/iahakaahijddcjjldidbclicedibgpjm?hl=en) · [Extension source](https://github.com/wchao6891/PromptDirector)

The catalog currently contains **45 case collections and 17 Skills**. Collections include Chinese-inspired visuals, visual development, product ads, posters, fashion, video prompts and cinematic techniques. See the [live catalog](https://promptdirector.cn/en/) for current packs and case counts; counts may include entries that appear in more than one pack.

| Original Chinese-Inspired Visuals | Brand Design | Cinematic Techniques |
|---|---|---|
| [Explore Vol.1](https://promptdirector.cn/en/collections/featured-cases-vol-1/) | [Explore Brand Design](https://promptdirector.cn/en/collections/cases-f05a7604a4a889ede786/) | [Explore Camera Movement](https://promptdirector.cn/en/collections/melies-camera-movement/) |

## Use a pack

1. Open the website and browse work, prompts, authors and sources.
2. Download the reviewed pack or save it through PromptDirector's curated page.
3. Organize, compare and reuse references in your local projects. Browsing this repository does not upload your private library.

English pack names are display translations. The catalog retains the original `title` and may add `titleEn`; missing translations fall back to the original. Case text, author names, prompts and downloaded files are unchanged. English and Chinese pages download the same ZIP.

## Submit and review

Export the selected cases through **Share → Submit to curated** in PromptDirector, then upload all exported ZIP parts to the [English case submission form](https://github.com/wchao6891/PromptDirector-Curated/issues/new?template=curated-submission-en.yml). A GitHub account is required. A submission enters a public review queue and is never published automatically.

Automated preflight checks validate attachment domains, archive parts and checksums, paths and sizes, media headers and source fields. They do not execute submitted prompts or content. A maintainer then reviews quality, duplicates, privacy and rights before building and publishing approved packs. Original media is preserved; website thumbnails are separate previews. Video previews use media extracted from the same reviewed package.

For a Skill, use **Submit to curated Skill** in its detail view, review the files and cover, and upload the exported snapshot using the [English Skill form](https://github.com/wchao6891/PromptDirector-Curated/issues/new?template=curated-skill-submission-en.yml). Skill submissions use CC BY 4.0 and require human review. The reviewer assigns stable author, version and catalog identifiers. Public Skill content is untrusted reference material; the website does not run scripts or install it automatically.

## Rights and support

Each pack records its sources and rights status. Editorial acceptance does not prove redistribution permission or grant commercial rights. Third-party recommendations retain author attribution and sources and are marked as unverified when permission has not been established. Submitters cannot grant a license on another author's behalf. Read the [rights and sources policy](RIGHTS.en.md).

[Rights report or removal request](https://github.com/wchao6891/PromptDirector-Curated/issues/new?template=rights-report-en.yml) · [Support](https://promptdirector.cn/en/support.html) · [Privacy](https://promptdirector.cn/en/privacy.html)

This repository contains public catalogs, previews and release materials. Private cases, evaluation material, sync data and API keys do not belong here. Follows stay on the current device; the product does not offer likes, public follower counts, comments or algorithmic rankings.

## Maintainer publishing sequence

1. Build reviewed packs from extension exports: `node tools/build-curated-batch.mjs build.json`.
2. Publish the download ZIP as a Release asset, update catalog, covers and rights records, then refresh verified download metrics: `node tools/sync-release-metrics.mjs site/public-catalog.json site/metrics.json`.
3. For packs containing video, prepare immutable media assets with `tools/prepare-media-releases.mjs`, then publish them with `tools/publish-media-release.mjs`. These tools require the catalog, reviewed package/media directories, repository and package ID; see the [full command sequence](README.zh-CN.md#维护者本地命令含视频按顺序). Never overwrite published media assets.
4. Generate read-only previews with `tools/build-site-previews.mjs` and activate versioned previews with `tools/activate-media-previews.mjs`, using the media manifest. Video packs without a media manifest are rejected to avoid publishing covers without playable media.
5. Validate with `node tools/validate-catalog.mjs && node tools/validate-skill-catalog.mjs`, submit the reviewed changes and verify the deployed website. A failed metrics refresh retains the last verified snapshot.

## Website and catalog

[PromptDirector.cn](https://promptdirector.cn/en/) is the official website for cases, collections, Skills and guides. It is built from the reviewed catalog in this repository. See [build, localization and migration documentation](docs/website.md). Legacy GitHub Pages data and media URLs remain available for released extensions and existing references.
