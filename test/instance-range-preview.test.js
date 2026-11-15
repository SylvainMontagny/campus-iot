const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createPreview() {
  const fields = {
    "identity.maxDevNum": { value: "10" },
    "bacnet.offsetAV": { value: "100" },
    "bacnet.instanceRangeAV": { value: "10" },
    "bacnet.offsetBV": { value: "200" },
    "bacnet.instanceRangeBV": { value: "5" }
  };
  const customInputs = [{ value: "3" }];
  const cells = ["AV", "BV"].flatMap((type) => [0, 1, 2, "custom"].map((num) => ({
    dataset: { instanceRange: type, instanceNum: String(num) },
    textContent: ""
  })));
  const panel = {
    querySelector(selector) {
      return fields[selector.match(/^\[data-path="([^"]+)"\]$/)?.[1]];
    },
    querySelectorAll(selector) {
      if (selector === "[data-instance-device-num]") return customInputs;
      if (selector === "[data-instance-range]") return cells;
      throw new Error(`Unexpected selector: ${selector}`);
    }
  };
  const listeners = {};
  const document = {
    querySelector(selector) {
      if (selector === "#device-config-panel") return panel;
      if (selector === "#import-file") return { addEventListener() {} };
      throw new Error(`Unexpected selector: ${selector}`);
    },
    addEventListener(type, handler) { listeners[type] = handler; }
  };
  const context = vm.createContext({ document });
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  vm.runInContext(source.slice(0, source.lastIndexOf("\ninitializeAuthentication();")), context);
  vm.runInContext('state.selectedDevice = "loraDeviceA"', context);
  const input = (target, isCustom) => listeners.input({
    target: { ...target, matches: (selector) => isCustom ? selector.includes("[data-instance-device-num]") : selector.includes(`[data-path="${target.path}"]`) }
  });
  const text = (type, num) => cells.find((cell) => cell.dataset.instanceRange === type && cell.dataset.instanceNum === String(num)).textContent;
  return { context, fields, customInputs, input, text };
}

test("preview renders one table with device names and AV and BV ranges", () => {
  const preview = createPreview();
  const html = vm.runInContext('instanceRangeTablesHtml("loraDeviceA")', preview.context);
  assert.match(html, /Instance range computation/);
  assert.equal((html.match(/<table/g) || []).length, 1);
  assert.match(html, /<th scope="col">LoRaWAN device name<\/th><th scope="col">AV instance range<\/th><th scope="col">BV instance range<\/th>/);
  assert.equal((html.match(/<tr><td>/g) || []).length, 4);
  for (const num of [0, 1, 2, "custom"]) {
    const name = num === "custom" ? 'loraDeviceA-<input' : `loraDeviceA-${num}`;
    assert.ok(html.includes(`${name}`));
    assert.match(html, new RegExp(`<td data-instance-range="AV" data-instance-num="${num}"></td><td data-instance-range="BV" data-instance-num="${num}"></td>`));
  }
  assert.equal((html.match(/data-instance-device-num/g) || []).length, 1);
  vm.runInContext("updateInstanceRangeTables()", preview.context);
  assert.equal(preview.text("AV", 0), "From 100 to 109");
  assert.equal(preview.text("BV", 0), "From 200 to 204");
  assert.equal(preview.text("AV", 1), "From 110 to 119");
  assert.equal(preview.text("AV", 2), "From 120 to 129");
  assert.equal(preview.text("AV", "custom"), "From 130 to 139");
  assert.equal(preview.text("BV", "custom"), "From 215 to 219");
  preview.fields["bacnet.offsetAV"].value = "0";
  preview.input({ path: "bacnet.offsetAV", value: "0" }, false);
  assert.deepEqual([0, 1, 2].map((num) => preview.text("AV", num)), ["From 0 to 9", "From 10 to 19", "From 20 to 29"]);
});

test("each profile field updates the preview on input, including zero and invalid values", () => {
  const preview = createPreview();
  const change = (path, value) => {
    preview.fields[path].value = value;
    preview.input({ path, value }, false);
  };
  change("bacnet.offsetAV", "50");
  assert.equal(preview.text("AV", 1), "From 60 to 69");
  change("bacnet.instanceRangeAV", "4");
  assert.equal(preview.text("AV", 2), "From 58 to 61");
  change("bacnet.offsetBV", "30");
  assert.equal(preview.text("BV", 1), "From 35 to 39");
  change("bacnet.instanceRangeBV", "0");
  assert.equal(preview.text("BV", 1), "No object available");
  assert.equal(preview.text("BV", "custom"), "No object available");
  change("bacnet.instanceRangeAV", "0");
  assert.equal(preview.text("AV", 2), "No object available");
  change("bacnet.instanceRangeAV", "");
  assert.equal(preview.text("AV", 1), "Enter a valid offset and object count");
});

test("custom number updates both range columns immediately, allows zero and rejects invalid values", () => {
  const preview = createPreview();
  preview.input({ value: "7" }, true);
  assert.equal(preview.text("AV", "custom"), "From 170 to 179");
  assert.equal(preview.text("BV", "custom"), "From 235 to 239");
  assert.equal(preview.customInputs[0].value, "7");
  preview.input({ value: "0" }, true);
  assert.equal(preview.text("AV", "custom"), "From 100 to 109");
  assert.equal(preview.text("BV", "custom"), "From 200 to 204");
  for (const value of ["", "-1", "1.5"]) {
    preview.input({ value }, true);
    assert.equal(preview.text("AV", "custom"), "Enter a non-negative whole device number");
  }
});

test("custom number is checked against the maximum as either input changes", () => {
  const preview = createPreview();
  preview.input({ value: "10" }, true);
  assert.equal(preview.text("AV", "custom"), "From 200 to 209");
  assert.equal(preview.text("BV", "custom"), "From 250 to 254");
  preview.input({ value: "11" }, true);
  assert.equal(preview.text("AV", "custom"), "device Number too high");
  assert.equal(preview.text("BV", "custom"), "device Number too high");
  preview.fields["bacnet.instanceRangeBV"].value = "0";
  preview.input({ path: "bacnet.instanceRangeBV", value: "0" }, false);
  assert.equal(preview.text("BV", "custom"), "device Number too high");
  preview.fields["identity.maxDevNum"].value = "11";
  preview.input({ path: "identity.maxDevNum", value: "11" }, false);
  assert.equal(preview.text("AV", "custom"), "From 210 to 219");
  assert.equal(preview.text("BV", "custom"), "No object available");
  preview.fields["identity.maxDevNum"].value = "0";
  preview.input({ path: "identity.maxDevNum", value: "0" }, false);
  assert.equal(preview.text("AV", "custom"), "device Number too high");
  preview.input({ value: "0" }, true);
  assert.equal(preview.text("AV", "custom"), "From 100 to 109");
  preview.fields["identity.maxDevNum"].value = "";
  preview.input({ path: "identity.maxDevNum", value: "" }, false);
  assert.equal(preview.text("AV", "custom"), "Enter a valid maximum device number");
  assert.equal(preview.text("BV", "custom"), "Enter a valid maximum device number");
});
