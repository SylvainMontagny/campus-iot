const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createEditorContext() {
  const container = { innerHTML: "", addEventListener() {} };
  const document = {
    addEventListener() {},
    querySelector() { return container; }
  };
  const context = vm.createContext({ document });
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  vm.runInContext(source.slice(0, source.lastIndexOf("\ninitializeAuthentication();")), context);
  vm.runInContext(`
    instanceRangeTablesHtml = () => "";
    updateInstanceRangeTables = () => {};
    previousValuesHtml = () => "";
    restoreTableScroll = () => {};
  `, context);
  return { context, container };
}

test("new device profiles render an empty half-width name field with catalog suggestions", () => {
  const { context, container } = createEditorContext();
  vm.runInContext(`
    state.config = {
      connections: {}, deviceConnections: {},
      deviceProfiles: {
        loraDeviceA: {
          identity: {}, controller: { debug: [] }, lorawan: { networkServer: "tts" },
          bacnet: { objects: {}, offsetAV: 0, offsetBV: 0, instanceRangeAV: 10, instanceRangeBV: 0 }
        }
      }
    };
    state.selectedDevice = "loraDeviceA";
    state.newDeviceProfiles.add("loraDeviceA");
    state.lorawanPayloadCatalog = { sensor: ["temperature"] };
    renderDevice();
  `, context);

  assert.match(container.innerHTML, /class="field-row field-half"><label class="field"><span>Device profile name<\/span><input[^>]*value=""[^>]*list="device-profile-options"/);
  assert.match(container.innerHTML, /<datalist id="device-profile-options"><option value="sensor"><\/option><\/datalist>/);
});

test("new BACnet objects render empty half-width payload and object name fields", () => {
  const { context } = createEditorContext();
  const html = vm.runInContext(`
    state.selectedDevice = "loraDeviceA";
    state.config = {
      deviceProfiles: {
        loraDeviceA: { bacnet: { objects: { "object-1": { dataDirection: "uplink", objectType: "analogValue", assignementMode: "auto" } } } }
      }
    };
    state.newObjects.add("loraDeviceA::object-1");
    state.lorawanPayloadCatalog = { loraDeviceA: ["temperature"] };
    renderObject("object-1", state.config.deviceProfiles.loraDeviceA.bacnet.objects["object-1"]);
  `, context);

  assert.match(html, /class="field-row field-half"><label class="field"><span>LoRaWAN payload name<\/span><input[^>]*value=""[^>]*list="lorawan-payload-names-/);
  assert.match(html, /<span>BACnet object name<\/span><input[^>]*value=""/);
});
