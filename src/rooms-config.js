function createDefaultRoomsSchedules() {
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
    rooms: []
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

// Validates only the keys present, so it serves both the global defaults and per-room overrides.
function validateRoomSettings(settings, basePath, errors) {
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

function validateRoomsSchedules(data, { deviceList = {}, connections = {} } = {}) {
  const errors = [];
  const conf = data?.icalToScheduleConf;
  if (!conf || typeof conf !== "object" || !Array.isArray(data.rooms)) {
    return [issue("Rooms & Schedules must contain icalToScheduleConf and a rooms list", "roomsSchedules")];
  }

  const confPath = "roomsSchedules.icalToScheduleConf";
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
  if (!conf.defaults || typeof conf.defaults !== "object") errors.push(issue("Default room settings are missing", `${confPath}.defaults`));
  else validateRoomSettings(conf.defaults, `${confPath}.defaults`, errors);

  if (rangeValid && data.rooms.length > max - min + 1) {
    errors.push(issue("Too many rooms, increase the schedule instance range", "roomsSchedules.rooms"));
  }

  const names = new Set();
  const usedNumbers = {};
  data.rooms.forEach((room, index) => {
    const roomPath = `roomsSchedules.rooms.${index}`;
    if (!room || typeof room !== "object") {
      errors.push(issue("Room must be an object", roomPath));
      return;
    }
    // The name ends up in BACnet binding names that are used in URLs.
    if (typeof room.scheduleName !== "string" || !room.scheduleName || /\s/.test(room.scheduleName)) {
      errors.push(issue("Room name must be set and cannot contain spaces", `${roomPath}.scheduleName`));
    } else if (names.has(room.scheduleName)) {
      errors.push(issue(`Duplicate room name '${room.scheduleName}'`, `${roomPath}.scheduleName`));
    }
    names.add(room.scheduleName);

    const connection = connections[room.connectionName];
    if (!connection) errors.push(issue("Select an existing BACnet BMS connection", `${roomPath}.connectionName`));
    else if (connection.protocol !== "restAPIBacnet") errors.push(issue("Rooms & Schedules needs a 'REST API BACnet' connection", `${roomPath}.connectionName`));
    else if (!connection.ipAddress) errors.push(issue("The BMS connection has no IP address", `${roomPath}.connectionName`));

    if (typeof room.url !== "string" || !/^https?:\/\//i.test(room.url)) {
      errors.push(issue("iCal URL must start with http:// or https://", `${roomPath}.url`));
    }
    validateRoomSettings(room, roomPath, errors);

    if (!room.devices || typeof room.devices !== "object" || Array.isArray(room.devices)) {
      errors.push(issue("Devices must be an object", `${roomPath}.devices`));
      return;
    }
    for (const [type, device] of Object.entries(room.devices)) {
      const devicePath = `${roomPath}.devices.${type}`;
      const definition = deviceList[type];
      if (!definition) {
        errors.push(issue(`Device type '${type}' does not exist`, devicePath));
        continue;
      }
      const object = definition.bacnet?.objects?.[device?.AVToBindName];
      if (!object) errors.push(issue(`Object '${device?.AVToBindName}' does not exist in '${type}'`, `${devicePath}.AVToBindName`));
      else if (object.dataDirection !== "downlink") errors.push(issue(`'${device.AVToBindName}' is not a downlink object`, `${devicePath}.AVToBindName`));

      const numbers = device?.deviceNums;
      const maxDevNum = definition.identity?.maxDevNum;
      if (!Array.isArray(numbers) || !numbers.length || !numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= maxDevNum)) {
        errors.push(issue(`Device numbers must be whole numbers from 1 to ${maxDevNum}`, `${devicePath}.deviceNums`));
        continue;
      }
      usedNumbers[type] = (usedNumbers[type] || []).concat(numbers);
    }
  });

  for (const [type, numbers] of Object.entries(usedNumbers)) {
    if (new Set(numbers).size !== numbers.length) errors.push(issue(`${type}: a device number is used more than once`, "roomsSchedules.rooms"));
  }
  return errors;
}

// Fills every setting a room does not override from the global defaults and assigns the schedule instance numbers.
function resolveRooms({ icalToScheduleConf, rooms }) {
  const [min] = icalToScheduleConf.scheduleInstanceRange;
  return rooms.map((room, index) => {
    const resolved = structuredClone(room);
    for (const [key, value] of Object.entries(icalToScheduleConf.defaults)) resolved[key] ??= structuredClone(value);
    resolved.scheduleID = min + index;
    return resolved;
  });
}

module.exports = { createDefaultRoomsSchedules, validateRoomsSchedules, resolveRooms };
