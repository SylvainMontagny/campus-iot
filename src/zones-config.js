function createDefaultZonesSchedules() {
  return {
    icalToScheduleConf: {
      timeBetweenScheduleUpdate: 180,
      timeBetweenScheduleAVUpdate: 30,
      scheduleInstanceRange: [0, 50],
      scheduleAVInstanceOffset: 10000,
      logs: { eventsAddedInSchedules: true, eventTimeCreation: true, scheduleAVUpdate: true },
      defaults: {
        groupEvents: true,
        timeZone: "Europe/Paris",
        eventsToDiscard: ["SOBRIETE ENERGETIQUE"],
        minimumSlotDuration: 0,
        valueOccupied: 19,
        valueUnOccupied: 15,
        timeOffsetBeforeStart: 60,
        timeOffsetBeforeEnd: 60,
        nbrDaysPreview: 10,
        addSuffixToAdeURL: false,
        weekly: {
          monday: { transitions: {} },
          tuesday: { transitions: {} },
          wednesday: { transitions: {} },
          thursday: { transitions: {} },
          friday: { transitions: { 1: { time: "15:00:00.00", value: 7, key: "1" } } },
          saturday: { transitions: { 1: { time: "00:00:00.00", value: 7, key: "1" } } },
          sunday: {
            transitions: {
              1: { time: "00:00:00.00", value: 7, key: "1" },
              2: { time: "22:00:00.00", value: null, key: "2" }
            }
          }
        }
      }
    },
    zones: []
  };
}

function issue(message, path) {
  return { message, path };
}

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return true;
  } catch {
    return false;
  }
}

// Validates only the keys present, so it serves both the global defaults and per-zone overrides.
function validateZoneSettings(settings, basePath, errors) {
  const check = (key, valid, message) => {
    if (Object.hasOwn(settings, key) && !valid(settings[key])) errors.push(issue(message, `${basePath}.${key}`));
  };
  check("groupEvents", (v) => typeof v === "boolean", "Must be true or false");
  check("timeZone", (v) => typeof v === "string" && isValidTimeZone(v), "Must be a valid IANA time zone");
  check("eventsToDiscard", (v) => Array.isArray(v) && v.every((item) => typeof item === "string"), "Must be a list of names");
  check("minimumSlotDuration", (v) => isNumber(v) && v >= 0, "Must be a number of minutes, 0 or more");
  check("valueOccupied", isNumber, "Must be a number");
  check("valueUnOccupied", isNumber, "Must be a number");
  check("timeOffsetBeforeStart", (v) => isNumber(v) && v >= 0, "Must be a number of minutes, 0 or more");
  check("timeOffsetBeforeEnd", (v) => isNumber(v) && v >= 0, "Must be a number of minutes, 0 or more");
  check("nbrDaysPreview", (v) => Number.isInteger(v) && v >= 1, "Must be a whole number of days, 1 or more");
  check("addSuffixToAdeURL", (v) => typeof v === "boolean", "Must be true or false");
  check("weekly", (v) => v && typeof v === "object" && !Array.isArray(v), "Must be a JSON object");
}

function validateZonesSchedules(data, { deviceProfiles = {}, connections = {} } = {}) {
  const errors = [];
  const conf = data?.icalToScheduleConf;
  if (!conf || typeof conf !== "object" || !Array.isArray(data.zones)) {
    return [issue("Zones & Schedules must contain icalToScheduleConf and a zones list", "zonesSchedules")];
  }

  const confPath = "zonesSchedules.icalToScheduleConf";
  for (const key of ["timeBetweenScheduleUpdate", "timeBetweenScheduleAVUpdate"]) {
    if (!isNumber(conf[key]) || conf[key] <= 0) errors.push(issue("Must be a number of seconds greater than 0", `${confPath}.${key}`));
  }
  if (!Number.isInteger(conf.scheduleAVInstanceOffset) || conf.scheduleAVInstanceOffset < 0) {
    errors.push(issue("Must be a non-negative whole number", `${confPath}.scheduleAVInstanceOffset`));
  }
  const [min, max] = Array.isArray(conf.scheduleInstanceRange) ? conf.scheduleInstanceRange : [];
  const rangeValid = Number.isInteger(min) && Number.isInteger(max) && min >= 0 && min <= max;
  if (!rangeValid) errors.push(issue("Schedule instance range must be two whole numbers, first <= last", `${confPath}.scheduleInstanceRange`));
  if (conf.logs !== undefined && (!conf.logs || typeof conf.logs !== "object" || !Object.values(conf.logs).every((value) => typeof value === "boolean"))) {
    errors.push(issue("Log options must be true or false", `${confPath}.logs`));
  }
  if (!conf.defaults || typeof conf.defaults !== "object") errors.push(issue("Default zone settings are missing", `${confPath}.defaults`));
  else validateZoneSettings(conf.defaults, `${confPath}.defaults`, errors);

  if (rangeValid && data.zones.length > max - min + 1) {
    errors.push(issue("Too many zones, increase the schedule instance range", "In ZONES & SCHEDULES"));
  }

  const names = new Set();
  if (data.excludedZones !== undefined && !Array.isArray(data.excludedZones)) {
    errors.push(issue("Excluded zones must be a list", "zonesSchedules.excludedZones"));
  }
  const usedNumbers = {};
  data.zones.forEach((zone, index) => {
    const zonePath = `zonesSchedules.zones.${index}`;
    if (!zone || typeof zone !== "object") {
      errors.push(issue("Zone must be an object", zonePath));
      return;
    }
    // The name ends up in BACnet binding names that are used in URLs.
    if (typeof zone.scheduleName !== "string" || !zone.scheduleName || /\s/.test(zone.scheduleName)) {
      errors.push(issue("Zone name must be set and cannot contain spaces", `${zonePath}.scheduleName`));
    } else if (names.has(zone.scheduleName)) {
      errors.push(issue(`Duplicate zone name '${zone.scheduleName}'`, `${zonePath}.scheduleName`));
    }
    names.add(zone.scheduleName);

    const connection = connections[zone.connectionName];
    if (!connection) errors.push(issue("Select an existing BACnet BMS connection", `${zonePath}.connectionName`));
    else if (connection.protocol !== "restAPIBacnet") errors.push(issue("Zones & Schedules needs a 'REST API BACnet' connection", `${zonePath}.connectionName`));
    else if (!connection.ipAddress) errors.push(issue("The BMS connection has no IP address", `${zonePath}.connectionName`));

    if (typeof zone.url !== "string" || !/^https?:\/\//i.test(zone.url)) {
      errors.push(issue("iCal URL must start with http:// or https://", `${zonePath}.url`));
    }
    validateZoneSettings(zone, zonePath, errors);

    if (!zone.devices || typeof zone.devices !== "object" || Array.isArray(zone.devices)) {
      errors.push(issue("Devices must be an object", `${zonePath}.devices`));
      return;
    }
    for (const [profileName, device] of Object.entries(zone.devices)) {
      const devicePath = `${zonePath}.devices.${profileName}`;
      const definition = deviceProfiles[profileName];
      if (!definition) {
        errors.push(issue(`Device profile '${profileName}' does not exist`, devicePath));
        continue;
      }
      const object = definition.bacnet?.objects?.[device?.AVToBindName];
      if (!object) errors.push(issue(`Object '${device?.AVToBindName}' does not exist in '${profileName}'`, `${devicePath}.AVToBindName`));
      else if (object.dataDirection !== "downlink") errors.push(issue(`'${device.AVToBindName}' is not a downlink object`, `${devicePath}.AVToBindName`));

      const numbers = device?.deviceNums;
      const maxDevNum = definition.identity?.maxDevNum;
      if (!Array.isArray(numbers) || !numbers.length || !numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= maxDevNum)) {
        errors.push(issue(`Device numbers must be whole numbers from 1 to ${maxDevNum}`, `${devicePath}.deviceNums`));
        continue;
      }
      usedNumbers[profileName] = (usedNumbers[profileName] || []).concat(numbers);
    }
  });

  for (const [profileName, numbers] of Object.entries(usedNumbers)) {
    if (new Set(numbers).size !== numbers.length) errors.push(issue(`${profileName}: a device number is used more than once`, "In ZONES & SCHEDULES"));
  }
  return errors;
}

// Fills every setting a zone does not override from the global defaults and assigns the schedule instance numbers.
function resolveZones({ icalToScheduleConf, zones }) {
  const [min] = icalToScheduleConf.scheduleInstanceRange;
  return zones.map((zone, index) => {
    const resolved = structuredClone(zone);
    for (const [key, value] of Object.entries(icalToScheduleConf.defaults)) resolved[key] ??= structuredClone(value);
    resolved.scheduleID = min + index;
    resolved.url = applyAdeUrlSuffix(resolved);
    return resolved;
  });
}

// ADE calendars: set &lastDate=<today + nbrDaysPreview>. Idempotent, an existing &lastDate is replaced.
function applyAdeUrlSuffix(zone, now = new Date()) {
  if (!zone.addSuffixToAdeURL || typeof zone.url !== "string") return zone.url;
  const d = new Date(now);
  d.setDate(d.getDate() + zone.nbrDaysPreview);
  const suffix = d.toISOString().slice(0, 10);
  return zone.url.includes("&lastDate")
    ? zone.url.replace(/&lastDate=\d{4}-\d{2}-\d{2}/, `&lastDate=${suffix}`)
    : `${zone.url}&lastDate=${suffix}`;
}

// Non-blocking check: returns one warning per iCal URL shared by several zones.
function findDuplicateIcalUrls(zones) {
  const byUrl = new Map();
  for (const zone of zones) {
    const url = typeof zone?.url === "string" ? zone.url.trim() : "";
    if (!url) continue;
    byUrl.set(url, (byUrl.get(url) || []).concat(zone.scheduleName));
  }
  return [...byUrl].filter(([, names]) => names.length > 1)
    .map(([url, names]) => `Zones ${names.join(", ")} use the same iCal URL: ${url}`);
}

module.exports = { createDefaultZonesSchedules, validateZonesSchedules, resolveZones, applyAdeUrlSuffix, findDuplicateIcalUrls };
