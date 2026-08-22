import { readFile } from "node:fs/promises";
import { normalizeSiteSkillCatalog } from "./curated-skill-site-data.mjs";

const catalog = normalizeSiteSkillCatalog(JSON.parse(await readFile(new URL("../site/skills-catalog.json", import.meta.url), "utf8")));
process.stdout.write(`公开精选 Skill 目录有效：${catalog.skills.length} 个已审核版本\n`);
