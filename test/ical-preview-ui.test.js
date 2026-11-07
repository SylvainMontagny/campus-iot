const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("iCal test sends effective zone overrides or the selected configuration defaults", async () => {
  const handlers = {};
  const requests = [];
  const document = {
    addEventListener(type, handler) { handlers[type] = handler; },
    querySelector() { return { addEventListener() {} }; }
  };
  const context = vm.createContext({
    document,
    fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ message: "OK" }) };
    }
  });
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  vm.runInContext(source.slice(0, source.lastIndexOf("\nloadConfig();")), context);
  vm.runInContext(`
    state.config = defaultConfig();
    state.selectedZone = 0;
    state.config.zonesSchedules.icalToScheduleConf.defaults.nbrDaysPreview = 12;
    state.config.zonesSchedules.icalToScheduleConf.defaults.addSuffixToAdeURL = true;
    state.config.zonesSchedules.scheduleEventsConf.defaults.nbrDaysPreview = 7;
    state.config.zonesSchedules.scheduleEventsConf.defaults.addSuffixToAdeURL = false;
    state.config.zonesSchedules.scheduleEventsConf.defaults.timeZone = "UTC";
    state.config.zonesSchedules.zones = [{ url: "https://example.org/a", devices: {} }];
    showNotice = () => {};
    render = () => {};
  `, context);
  const button = { dataset: { action: "test-ical" }, classList: { contains: () => false }, disabled: false };
  const target = { closest: (selector) => selector === "[data-action]" ? button : null };
  await handlers.click({ target });
  assert.deepEqual(requests[0], { url: "/api/zones/test-ical", body: { url: "https://example.org/a", nbrDaysPreview: 12, addSuffixToAdeURL: true, timeZone: "Europe/Paris" } });
  vm.runInContext('state.config.zonesSchedules.zones[0].configuration = EVENTS_CONF', context);
  await handlers.click({ target });
  assert.deepEqual(requests[1].body, { url: "https://example.org/a", nbrDaysPreview: 7, addSuffixToAdeURL: false, timeZone: "UTC" });
  vm.runInContext('Object.assign(state.config.zonesSchedules.zones[0], { nbrDaysPreview: 3, addSuffixToAdeURL: true, timeZone: "Asia/Tokyo" })', context);
  await handlers.click({ target });
  assert.deepEqual(requests[2].body, { url: "https://example.org/a", nbrDaysPreview: 3, addSuffixToAdeURL: true, timeZone: "Asia/Tokyo" });
  assert.equal(button.disabled, false);
});
