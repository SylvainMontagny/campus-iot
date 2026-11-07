const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createEditor() {
  const elements = {};
  const handlers = {};
  const document = {
    addEventListener(type, handler) { handlers[type] = handler; },
    querySelector(selector) {
      elements[selector] ||= { innerHTML: "", addEventListener() {} };
      return elements[selector];
    }
  };
  const context = vm.createContext({ document });
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  vm.runInContext(source.slice(0, source.lastIndexOf("\nloadConfig();")), context);
  vm.runInContext(`
    state.config = defaultConfig();
    state.config.connections.bms = defaultConnection();
    state.selectedConnection = "bms";
    state.config.deviceProfiles.sensor = makeDevice("sensor", "bms");
    state.selectedDevice = "sensor";
    state.config.zonesSchedules.zones = [{ scheduleName: "zone", url: "", devices: {} }];
    state.selectedZone = 0;
    renderBmsObjects = () => {};
    previousValuesHtml = () => "";
    updateInstanceRangeTables = () => {};
    restoreTableScroll = () => {};
  `, context);
  return { context, elements, handlers };
}

test("save buttons appear at the requested sections", () => {
  const { context, elements } = createEditor();
  vm.runInContext("renderGlobal(); renderDevice(); renderScheduleGlobal(); renderZone();", context);
  assert.match(elements["#global-form"].innerHTML, /data-action="test-connection">Test<\/button><button class="button button-primary" type="button" data-save-config>Save<\/button>/);
  assert.match(elements["#device-editor"].innerHTML, /class="object-list">[\s\S]*?<\/div>\s*<div class="section-save-actions">[\s\S]*?data-save-config[\s\S]*?<\/div>\s*<section class="previous-values"/);
  const schedule = elements["#schedule-global-editor"].innerHTML;
  assert.equal((schedule.match(/data-conf-key=/g) || []).length, 2);
  assert.equal((schedule.match(/data-save-config/g) || []).length, 2);
  assert.match(elements["#zone-editor"].innerHTML, /<h2>Devices[\s\S]*class="section-save-actions">[\s\S]*data-save-config/);
  vm.runInContext('state.config.zonesSchedules.zones[0].excluded = true; renderZone()', context);
  assert.match(elements["#zone-editor"].innerHTML, /is-zone-excluded[\s\S]*<\/div><div class="section-save-actions">[\s\S]*data-save-config/);
  vm.runInContext('state.config.zonesSchedules.zones[0].configuration = EVENTS_CONF; renderZone()', context);
  assert.doesNotMatch(elements["#zone-editor"].innerHTML, /data-save-config/);
});

test("top and section save buttons call the same save function", async () => {
  const { context, handlers } = createEditor();
  vm.runInContext("var saveCalls = 0; saveConfig = async () => { saveCalls += 1; };", context);
  for (const selector of ["#save-button", "[data-save-config]"]) {
    const target = { closest: (candidate) => candidate.split(",").map((part) => part.trim()).includes(selector) ? target : null };
    await handlers.click({ target });
  }
  assert.equal(vm.runInContext("saveCalls", context), 2);
});

test("existing-schedule zones show only a BACnet schedule ID while preserving the internal zone name", () => {
  const { context, elements } = createEditor();
  vm.runInContext('render = () => renderZone(); renderZone();', context);
  assert.match(elements["#zone-editor"].innerHTML, /data-zone-field="scheduleName"/);
  assert.doesNotMatch(elements["#zone-editor"].innerHTML, /data-zone-field="scheduleID"/);
  vm.runInContext('handleZoneField({ dataset: { zoneField: "configuration" }, value: EVENTS_CONF })', context);
  assert.doesNotMatch(elements["#zone-editor"].innerHTML, /data-zone-field="scheduleName"/);
  assert.match(elements["#zone-editor"].innerHTML, /data-zone-field="scheduleID"/);
  vm.runInContext('handleZoneField({ dataset: { zoneField: "scheduleID" }, type: "number", value: "0" })', context);
  assert.match(elements["#zone-editor"].innerHTML, /data-zone-field="scheduleID" type="number" value="0"/);
  assert.equal(vm.runInContext("state.config.zonesSchedules.zones[0].scheduleName", context), "zone");
  vm.runInContext('handleZoneField({ dataset: { zoneField: "configuration" }, value: ICAL_CONF })', context);
  assert.match(elements["#zone-editor"].innerHTML, /data-zone-field="scheduleName" type="text" value="zone"/);
  assert.doesNotMatch(elements["#zone-editor"].innerHTML, /data-zone-field="scheduleID"/);
});
