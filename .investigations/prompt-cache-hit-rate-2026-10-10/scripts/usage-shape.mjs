import fs from "node:fs";
const lines = fs.readFileSync("C:/Users/HUANGC~1/AppData/Local/Temp/tl-cache-audit/session.jsonl", "utf8").split(/\r?\n/).filter(Boolean);
const evs = lines.map((l) => JSON.parse(l));

// find the usage object shape on the first assistant/message
const first = evs.find((e) => e.type === "assistant/message" && e.data?.message?.usage);
console.log("usage key path sample:", JSON.stringify(first?.data?.message?.usage, null, 2));
console.log("assistant/message keys:", Object.keys(first?.data?.message || {}));
