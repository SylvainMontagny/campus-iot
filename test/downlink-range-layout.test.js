const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function render(strategy) {
  const document = {
    addEventListener() {},
    querySelector() { return { addEventListener() {} }; }
  };
  const context = vm.createContext({ document });
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  vm.runInContext(source.slice(0, source.lastIndexOf("\nloadConfig();")), context);
  return vm.runInContext(`
    state.selectedDevice = "device";
    state.config = { deviceProfiles: { device: { bacnet: { objects: {} } } } };
    renderObject("setpoint", {
      dataDirection: "downlink", objectType: "analogValue", assignementMode: "auto",
      downlinkStrategy: ${JSON.stringify(strategy)}, range: [-2, 4]
    });
  `, context);
}

for (const strategy of ["compareToUplinkObjectWithinRange", "onChangeOfThisValueWithinRange"]) {
  test(`${strategy} renders range fields in one pair`, () => {
    const html = render(strategy);
    assert.match(html, /<div class="field-pair downlink-range">.*data-path="range\.0".*value="-2".*data-path="range\.1".*value="4".*<\/div>/);
  });
}

test("non-range strategy does not render range inputs", () => {
  assert.doesNotMatch(render("onChangeOfThisValue"), /data-path="range\.[01]"/);
});
