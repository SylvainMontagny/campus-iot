const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createPayloadCatalog } = require("../src/lorawan-to-bacnet/payload-catalog");

test("stores the union of observed payload names per device profile", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "campus-iot-payload-catalog-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const catalog = createPayloadCatalog(directory);

  await Promise.all([
    catalog.record({ deviceProfile: "sensor", payloadNames: ["temperature"] }),
    catalog.record({ deviceProfile: "sensor", payloadNames: ["humidity", "temperature"] })
  ]);

  assert.deepEqual(await catalog.get(), { sensor: ["temperature", "humidity"] });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, "lorawan-payload-catalog.json"), "utf8")), {
    sensor: ["temperature", "humidity"]
  });
  assert.deepEqual(await createPayloadCatalog(directory).get(), { sensor: ["temperature", "humidity"] });
});
