const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createNavigation() {
  const elements = {};
  const handlers = {};
  const document = {
    addEventListener(type, handler) { handlers[type] = handler; },
    querySelector(selector) {
      elements[selector] ||= {
        innerHTML: "",
        classList: { toggle() {} },
        addEventListener() {},
        focus() { this.focused = true; }
      };
      return elements[selector];
    }
  };
  const context = vm.createContext({ document });
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  vm.runInContext(source.slice(0, source.lastIndexOf("\nloadConfig();")), context);
  vm.runInContext(`
    state.config = defaultConfig();
    state.config.zonesSchedules.zones = [
      { scheduleName: "room-a", devices: {} },
      { scheduleName: "schedule-b", configuration: EVENTS_CONF, devices: {} },
      { scheduleName: "room-c", configuration: ICAL_CONF, excluded: true, devices: {} }
    ];
    state.selectedView = "zone";
    state.selectedZone = 1;
    render = () => renderNavigation();
    renderNavigation();
  `, context);
  return { context, elements, handlers, html: () => elements["#zone-navigation"].innerHTML };
}

test("groups zones by configuration with original indices and collapsed accordions", () => {
  const nav = createNavigation();
  const html = nav.html();
  assert.match(html, /Manage LoRaWAN devices/);
  assert.match(html, /Add events to an existing schedule/);
  assert.equal((html.match(/aria-expanded="false"/g) || []).length, 2);
  assert.equal((html.match(/class="zone-nav-list" hidden/g) || []).length, 2);
  const [rooms, schedules] = html.split('<section class="zone-nav-group">').slice(1);
  assert.match(rooms, /data-select-zone="0"[\s\S]*room-a/);
  assert.match(rooms, /data-select-zone="2"[\s\S]*room-c[\s\S]*is-off/);
  assert.doesNotMatch(rooms, /schedule-b/);
  assert.match(schedules, /is-selected" type="button" data-select-zone="1"[\s\S]*schedule-b/);
  assert.doesNotMatch(schedules, /room-a|room-c/);
});

test("accordion toggles independently, retains state across renders and selection", async () => {
  const nav = createNavigation();
  const toggle = async (key) => {
    const button = { dataset: { zoneGroupToggle: key } };
    await nav.handlers.click({ target: { closest: (selector) => selector === "[data-zone-group-toggle]" ? button : null } });
  };
  await toggle("icalToScheduleConf");
  assert.equal(vm.runInContext("state.expandedZoneGroups[ICAL_CONF]", nav.context), true);
  assert.equal(nav.elements['[data-zone-group-toggle="icalToScheduleConf"]'].focused, true);
  assert.match(nav.html(), /data-zone-group-toggle="icalToScheduleConf" aria-expanded="true"/);
  assert.match(nav.html(), /data-zone-group-toggle="scheduleEventsConf" aria-expanded="false"/);
  await toggle("scheduleEventsConf");
  const zone = { dataset: { selectZone: "2" } };
  await nav.handlers.click({ target: { closest: (selector) => selector === "[data-select-zone]" ? zone : null } });
  assert.equal(vm.runInContext("state.selectedZone", nav.context), 2);
  assert.equal((nav.html().match(/aria-expanded="true"/g) || []).length, 2);
  await toggle("icalToScheduleConf");
  assert.match(nav.html(), /data-zone-group-toggle="icalToScheduleConf" aria-expanded="false"/);
  assert.match(nav.html(), /data-zone-group-toggle="scheduleEventsConf" aria-expanded="true"/);
});

test("moving or adding a zone opens the appropriate group", async () => {
  const nav = createNavigation();
  vm.runInContext('state.selectedZone = 0; handleZoneField({ dataset: { zoneField: "configuration" }, value: EVENTS_CONF })', nav.context);
  assert.match(nav.html(), /data-zone-group-toggle="scheduleEventsConf" aria-expanded="true"/);
  const [rooms, schedules] = nav.html().split('<section class="zone-nav-group">').slice(1);
  assert.doesNotMatch(rooms, /room-a/);
  assert.match(schedules, /data-select-zone="0"[\s\S]*room-a/);
  const add = { dataset: { action: "add-zone" }, classList: { contains: () => false } };
  await nav.handlers.click({ target: { closest: (selector) => selector === "[data-action]" ? add : null } });
  assert.match(nav.html(), /data-zone-group-toggle="icalToScheduleConf" aria-expanded="true"/);
  assert.match(nav.html(), /data-select-zone="3"[\s\S]*zone-4/);
});
