const fs = require("node:fs/promises");
const path = require("node:path");

const dataDirectory = path.join(__dirname, "..", "..", "data");

function createPayloadCatalog(directory = dataDirectory) {
  const filePath = path.join(directory, "lorawan-payload-catalog.json");
  let catalog;
  let updateQueue = Promise.resolve();

  async function load() {
    if (catalog) return catalog;
    try {
      const saved = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
        throw new Error("LoRaWAN payload catalog must contain an object");
      }
      const entries = Object.entries(saved);
      if (entries.some(([, names]) => !Array.isArray(names) || names.some((name) => typeof name !== "string"))) {
        throw new Error("LoRaWAN payload catalog entries must be arrays of strings");
      }
      catalog = Object.fromEntries(entries.map(([profile, names]) => [profile, [...new Set(names)]]));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      catalog = {};
    }
    return catalog;
  }

  async function get() {
    await updateQueue;
    return structuredClone(await load());
  }

  function record({ deviceProfile, payloadNames }) {
    const operation = updateQueue.then(async () => {
      const current = await load();
      const hasProfile = Object.hasOwn(current, deviceProfile);
      const previousNames = hasProfile ? current[deviceProfile] : [];
      const nextNames = [...new Set([...previousNames, ...payloadNames])];
      if (hasProfile && nextNames.length === previousNames.length) return;

      const updated = Object.fromEntries([...Object.entries(current), [deviceProfile, nextNames]]);
      await fs.mkdir(directory, { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      await fs.writeFile(temporaryPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
      await fs.rename(temporaryPath, filePath);
      catalog = updated;
    });
    updateQueue = operation.catch(() => {});
    return operation;
  }

  return { get, record };
}

module.exports = { createPayloadCatalog };
