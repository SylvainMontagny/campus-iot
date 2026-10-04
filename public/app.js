const state = {
  config: null,
  selectedDevice: null,
  selectedConnection: null,
  selectedView: "global",
  expandedDevices: {},
  expandedObjects: {},
  noticeTimer: null,
  mqttLogId: 0,
  mqttRawId: 0,
  paused: { log: false, raw: false }
};

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[character]));

function defaultConfig() {
  return {
    deviceList: {},
    connections: {},
    deviceConnections: {}
  };
}

function defaultConnection() {
  return {
    ipAddress: "", networkServer: "tts", grpcApiKey: "", serverAddress: "", grpcPort: 8080,
    protocol: "bacnet", model: "distechControlsV2", bacnetLogin: "", bacnetPassword: ""
  };
}

function makeDevice(name, connectionName) {
  const device = {
    identity: { maxDevNum: 10 },
    controller: { debug: ["all"], connectionName: connectionName || "" },
    lorawan: { flushDownlinkQueue: false, class: "A" },
    bacnet: { offsetAV: 0, offsetBV: 0, instanceRangeAV: 10, instanceRangeBV: 10, objects: {} },
    mqtt: { topicDownlink: {} }
  };
  state.config.deviceConnections[name] = connectionName || "";
  if (connectionName) applyConnection(device, state.config.connections[connectionName], connectionName);
  return device;
}

function makeObject() {
  return {
    lorawanPayloadName: "payload-name", dataDirection: "uplink", downlinkPort: 30,
    assignementMode: "auto", downlinkStrategy: "compareToUplinkObject", instanceNum: 0,
    downlinkPortPriority: "low", objectType: "analogValue", uplinkToCompareWith: "",
    range: [0, 100], value: 0
  };
}

function setPath(object, path, value) {
  const keys = path.split(".");
  const finalKey = keys.pop();
  const parent = keys.reduce((current, key) => current[key], object);
  parent[finalKey] = value;
}

function inputField(label, path, value, options = {}) {
  const { type = "text", wide = false, min, max, step, secret = false, placeholder = "" } = options;
  const attrs = [min !== undefined ? `min="${min}"` : "", max !== undefined ? `max="${max}"` : "", step !== undefined ? `step="${step}"` : ""].filter(Boolean).join(" ");
  return `<label class="field${wide ? " field-wide" : ""}"><span>${escapeHtml(label)}</span><input data-path="${escapeHtml(path)}" type="${secret ? "password" : type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" ${attrs} autocomplete="off"></label>`;
}

function selectField(label, path, value, options, wide = false) {
  const choices = options.map(([optionValue, text]) => `<option value="${escapeHtml(optionValue)}"${String(value) === String(optionValue) ? " selected" : ""}>${escapeHtml(text)}</option>`).join("");
  return `<label class="field${wide ? " field-wide" : ""}"><span>${escapeHtml(label)}</span><select data-path="${escapeHtml(path)}">${choices}</select></label>`;
}

function checkbox(label, checked, key) {
  return `<label class="check-field"><input type="checkbox" data-debug="${key}"${checked ? " checked" : ""}><span>${escapeHtml(label)}</span></label>`;
}

function applyConnection(device, connection, connectionName = "") {
  device.controller ||= {};
  device.controller.connectionName = connectionName;
  if (!connection) return;
  device.controller.protocol = connection.protocol;
  device.controller.ipAddress = connection.ipAddress;
  if (connection.protocol === "restAPIBacnet") {
    device.controller.model = connection.model;
    device.controller.login = connection.bacnetLogin;
    device.controller.password = connection.bacnetPassword;
  } else {
    delete device.controller.model;
    delete device.controller.login;
    delete device.controller.password;
  }

  device.lorawan ||= {};
  device.lorawan.networkServer = connection.networkServer;
  if (connection.networkServer === "chirpstack") {
    device.lorawan.chirpstack = {
      grpcApiKey: connection.grpcApiKey,
      serverAddress: connection.serverAddress,
      grpcPort: Number(connection.grpcPort) || 8080
    };
  } else {
    delete device.lorawan.chirpstack;
  }
  if (connection.networkServer === "actility" && hasDownlink(device)) {
    device.lorawan.actility ||= { driver: { pId: "", mId: "", ver: "" } };
  } else {
    delete device.lorawan.actility;
  }
}

function applyConnectionToAssignedDevices(connectionName) {
  for (const [deviceName, device] of Object.entries(state.config.deviceList)) {
    if (state.config.deviceConnections[deviceName] === connectionName) {
      applyConnection(device, state.config.connections[connectionName], connectionName);
    }
  }
}

function connectionFromDevice(device) {
  const controller = device.controller || {};
  const lorawan = device.lorawan || {};
  const chirpstack = lorawan.chirpstack || {};
  return {
    ipAddress: controller.ipAddress || "",
    networkServer: lorawan.networkServer || "tts",
    grpcApiKey: chirpstack.grpcApiKey || "",
    serverAddress: chirpstack.serverAddress || "",
    grpcPort: chirpstack.grpcPort || 8080,
    protocol: controller.protocol || "bacnet",
    model: controller.model || "distechControlsV2",
    bacnetLogin: controller.login || "",
    bacnetPassword: controller.password || ""
  };
}

function rebuildConnectionsFromDeviceList(deviceList) {
  const connections = {};
  const deviceConnections = {};
  let unnamedIndex = 1;

  for (const [deviceName, device] of Object.entries(deviceList)) {
    let connectionName = device.controller?.connectionName?.trim();
    if (!connectionName) {
      while (Object.hasOwn(connections, `Connection ${unnamedIndex}`)) unnamedIndex += 1;
      connectionName = `Connection ${unnamedIndex++}`;
    }
    const settings = connectionFromDevice(device);
    if (connections[connectionName] && JSON.stringify(connections[connectionName]) !== JSON.stringify(settings)) {
      throw new Error(`Devices assigned to connection '${connectionName}' have conflicting settings.`);
    }
    connections[connectionName] = settings;
    deviceConnections[deviceName] = connectionName;
    device.controller ||= {};
    device.controller.connectionName = connectionName;
  }

  return { connections, deviceConnections };
}

function hasDownlink(device) {
  return Object.values(device.bacnet?.objects || {}).some((object) => object.dataDirection === "downlink");
}

function renderGlobal() {
  const connectionName = state.selectedConnection;
  const global = state.config.connections[connectionName];
  const removeButton = $("[data-action='delete-connection']");
  const nameInput = $("#connection-name");
  if (!global) {
    nameInput.value = "";
    nameInput.disabled = true;
    removeButton.disabled = true;
    $("#global-form").innerHTML = `<div class="connection-empty"><h3>No connection profiles</h3><p>Create a named connection profile, then select it from a device type.</p><button class="button button-primary" type="button" data-action="add-connection">Add connection</button></div>`;
    return;
  }

  nameInput.disabled = false;
  nameInput.value = connectionName;
  removeButton.disabled = false;
  const fields = [
    `<div class="field-row">${inputField("BMS IP address", "ipAddress", global.ipAddress, { placeholder: "192.168.1.10" })}</div>`,
    `<div class="field-row">${selectField("Network server", "networkServer", global.networkServer, [["tts", "The Things Stack"], ["chirpstack", "ChirpStack"], ["actility", "Actility"]])}</div>`,
    `<div class="field-pair">${selectField("BMS protocol", "protocol", global.protocol, [["bacnet", "BACnet"], ["restAPIBacnet", "REST API BACnet"]])}${global.protocol === "restAPIBacnet" ? selectField("REST API model", "model", global.model, [["distechControlsV2", "Distech Controls v2"]]) : ""}</div>`
  ];
  if (global.networkServer === "chirpstack") {
    fields.push(`<div class="field-row">${inputField("gRPC API key", "grpcApiKey", global.grpcApiKey, { secret: true })}</div>`);
    fields.push(`<div class="field-pair">${inputField("Server address", "serverAddress", global.serverAddress)}${inputField("gRPC port", "grpcPort", global.grpcPort, { type: "number", min: 1, max: 65535 })}</div>`);
  }
  if (global.protocol === "restAPIBacnet") {
    fields.push(`<div class="field-pair">${inputField("Login", "bacnetLogin", global.bacnetLogin)}${inputField("Password", "bacnetPassword", global.bacnetPassword, { secret: true })}</div>`);
  }
  $("#global-form").innerHTML = fields.map((html) => html.replaceAll("data-path=", "data-connection-field=")).join("");
}

function renderNavigation() {
  const entries = Object.entries(state.config.deviceList);
  $("#device-count").textContent = entries.length;
  const connections = Object.entries(state.config.connections);
  $("#connection-count").textContent = `${connections.length} named ${connections.length === 1 ? "profile" : "profiles"}`;
  if (!connections.some(([name]) => name === state.selectedConnection)) state.selectedConnection = connections[0]?.[0] ?? null;
  if (!entries.some(([name]) => name === state.selectedDevice)) state.selectedDevice = entries[0]?.[0] ?? null;
  $("[data-select-view='global']").classList.toggle("is-selected", state.selectedView === "global");
  $("[data-select-view='mqtt']").classList.toggle("is-selected", state.selectedView === "mqtt");
  $("[data-select-view='log']").classList.toggle("is-selected", state.selectedView === "log");
  $("#connection-navigation").innerHTML = connections.map(([name]) => `
    <button class="device-nav-item connection-nav-item${state.selectedView === "global" && name === state.selectedConnection ? " is-selected" : ""}" type="button" data-select-connection="${escapeHtml(name)}">
      <span class="device-glyph connection-glyph" aria-hidden="true">↔</span>
      <span class="device-nav-copy"><strong>${escapeHtml(name)}</strong><small>${Object.values(state.config.deviceConnections).filter((assigned) => assigned === name).length} device types</small></span>
    </button>`).join("");
  $("#device-navigation").innerHTML = entries.map(([name, device]) => `
    <button class="device-nav-item${state.selectedView === "device" && name === state.selectedDevice ? " is-selected" : ""}" type="button" data-select-device="${escapeHtml(name)}">
      <span class="device-glyph" aria-hidden="true">${escapeHtml(name.slice(0, 1).toUpperCase())}</span>
      <span class="device-nav-copy"><strong>${escapeHtml(name)}</strong><small>${Object.keys(device.bacnet?.objects || {}).length} BACnet objects</small></span>
      <span class="nav-chevron" aria-hidden="true">›</span>
    </button>`).join("");
}

function renderDevice() {
  const container = $("#device-editor");
  const name = state.selectedDevice;
  if (!name) {
    container.innerHTML = `<div class="empty-state"><div class="empty-symbol" aria-hidden="true">+</div><h2>No device types yet</h2><p>Add a device type to define its LoRaWAN fleet and BACnet points.</p><button class="button button-primary" type="button" data-action="add-device">Add device type</button></div>`;
    return;
  }

  const device = state.config.deviceList[name];
  const objects = device.bacnet.objects || {};
  const debug = device.controller.debug || [];
  const deviceExpanded = Boolean(state.expandedDevices[name]);
  const assignedConnection = state.config.deviceConnections[name] || "";
  const connectionOptions = [["", "No connection profile"], ...Object.keys(state.config.connections).map((connectionName) => [connectionName, connectionName])];
  const deviceFields = [
    `<div class="field-row">${inputField("Device type name", "_name", name)}</div>`,
    `<div class="field-row">${selectField("LoRaWAN class", "lorawan.class", device.lorawan?.class || "A", [["A", "Class A"], ["B", "Class B"], ["C", "Class C"]])}</div>`,
    `<div class="field-row">${selectField("BMS connection", "deviceConnection", assignedConnection, connectionOptions).replace("data-path=", "data-device-connection=")}</div>`,
    `<div class="field-row">${inputField("Max device number", "identity.maxDevNum", device.identity?.maxDevNum, { type: "number", min: 1, step: 1 })}</div>`,
    `<div class="field-row">${selectField("Flush downlink queue", "lorawan.flushDownlinkQueue", String(Boolean(device.lorawan?.flushDownlinkQueue)), [["false", "No"], ["true", "Yes"]])}</div>`,
    `<div class="field-pair">${inputField("AV instance offset", "bacnet.offsetAV", device.bacnet.offsetAV, { type: "number", min: 0, step: 1 })}${inputField("AV instance range", "bacnet.instanceRangeAV", device.bacnet.instanceRangeAV, { type: "number", min: 0, step: 1 })}</div>`,
    `<div class="field-pair">${inputField("BV instance offset", "bacnet.offsetBV", device.bacnet.offsetBV, { type: "number", min: 0, step: 1 })}${inputField("BV instance range", "bacnet.instanceRangeBV", device.bacnet.instanceRangeBV, { type: "number", min: 0, step: 1 })}</div>`
  ];
  let actilityFields = "";
  if (device.lorawan.networkServer === "actility" && hasDownlink(device)) {
    const driver = device.lorawan.actility?.driver || {};
    actilityFields = `<div class="subsection-heading"><div><span class="eyebrow">ACTILITY DOWNLINK</span><h3>Driver identifiers</h3></div></div><div class="field-grid">
      ${inputField("Product ID (pId)", "lorawan.actility.driver.pId", driver.pId || "")}
      ${inputField("Model ID (mId)", "lorawan.actility.driver.mId", driver.mId || "")}
      ${inputField("Version", "lorawan.actility.driver.ver", driver.ver || "")}</div>`;
  }

  container.innerHTML = `
    <div class="section-heading device-heading"><div><span class="section-index">02</span><h2>Device type</h2></div></div>
    <section class="device-card${deviceExpanded ? " is-expanded" : ""}">
      <div class="panel-heading-row">
        <button class="panel-toggle" type="button" data-panel-toggle="device" aria-expanded="${deviceExpanded}" aria-controls="device-config-panel">
          <span class="panel-chevron" aria-hidden="true">${deviceExpanded ? "−" : "+"}</span>
          <span class="panel-heading-copy"><span class="eyebrow">DEVICE TYPE</span><strong>${escapeHtml(name)}</strong></span>
          <span class="mono-tag">${escapeHtml((device.lorawan.networkServer || "unassigned").toUpperCase())}</span>
          <span class="panel-summary-count">${Object.keys(objects).length} objects</span>
        </button>
        <button class="button button-danger-quiet" type="button" data-action="delete-device">Remove type</button>
      </div>
      <div id="device-config-panel" class="device-card-body"${deviceExpanded ? "" : " hidden"}>
      <div class="field-grid">${deviceFields.join("")}</div>
      <div class="subsection-heading debug-heading"><div><span class="eyebrow">DIAGNOSTICS</span><h3>Debug events</h3></div></div>
      <div class="check-grid">${checkbox("All events", debug.includes("all"), "all")}${checkbox("Uplink events", debug.includes("up"), "up")}${checkbox("Downlink events", debug.includes("down"), "down")}${checkbox("Creation events", debug.includes("creation"), "creation")}${checkbox("Transmit time", debug.includes("txTime"), "txTime")}</div>
      <div class="subsection-heading debug-heading"><div><h3>Print device object</h3></div></div>
      <div class="check-grid">${checkbox("After MQTT reception", debug.includes("deviceMqtt"), "deviceMqtt")}${checkbox("After uplink process", debug.includes("deviceUplink"), "deviceUplink")}${checkbox("After downlink process", debug.includes("deviceDownlink"), "deviceDownlink")}</div>
      <div class="subsection-heading debug-heading"><div><h3>Print previousValues</h3></div></div>
      <div class="check-grid">${checkbox("After MQTT reception", debug.includes("previousValuesMqtt"), "previousValuesMqtt")}</div>
      ${actilityFields}
      </div>
    </section>
    <div class="objects-heading"><div><span class="eyebrow">BACNET MAPPING</span><h2>Objects <span class="object-count">${Object.keys(objects).length}</span></h2></div><button class="button button-outline" type="button" data-action="add-object">+ Add object</button></div>
    <div class="object-list">${Object.entries(objects).map(([objectName, object]) => renderObject(objectName, object)).join("") || `<div class="empty-objects">No BACnet objects. Add an object to map decoded payload values.</div>`}</div>`;
}

function renderObject(name, object) {
  const downlink = object.dataDirection === "downlink";
  const objectKey = `${state.selectedDevice}::${name}`;
  const objectExpanded = Boolean(state.expandedObjects[objectKey]);
  const range = Array.isArray(object.range) ? object.range : [0, 100];
  const instanceLabel = object.assignementMode === "manual" ? "Instance number" : "Instance number offset";
  const uplinkNames = Object.entries(state.config.deviceList[state.selectedDevice]?.bacnet?.objects || {})
    .filter(([, candidate]) => candidate.dataDirection === "uplink")
    .map(([candidateName]) => candidateName);
  if (object.uplinkToCompareWith && !uplinkNames.includes(object.uplinkToCompareWith)) uplinkNames.push(object.uplinkToCompareWith);
  const uplinkObjectOptions = [["", "Select an uplink object"], ...uplinkNames.map((candidateName) => [candidateName, candidateName])];
  const core = [
    `<div class="field-row">${inputField("LoRaWAN payload name", "lorawanPayloadName", object.lorawanPayloadName || "")}</div>`,
    `<div class="field-row">${inputField("BACnet object name", "_name", name)}</div>`,
    `<div class="field-row">${selectField("BACnet Object type", "objectType", object.objectType, [["analogValue", "Analog value"], ["binaryValue", "Binary value"]])}</div>`,
    `<div class="field-pair">${selectField("Assignation mode", "assignementMode", object.assignementMode, [["auto", "Automatic"], ["manual", "Manual"]])}${inputField(instanceLabel, "instanceNum", object.instanceNum, { type: "number", min: 0, step: 1 })}</div>`,
    `<div class="field-row">${selectField("Direction", "dataDirection", object.dataDirection, [["uplink", "Uplink"], ["downlink", "Downlink"]])}</div>`
  ];
  const downlinkFields = downlink ? `
    <div class="field-grid downlink-fields">
      <div class="field-row">${inputField("Downlink FPort", "downlinkPort", object.downlinkPort, { type: "number", min: 0, max: 255, step: 1 })}</div>
      <div class="${object.downlinkStrategy?.startsWith("compareToUplinkObject") ? "field-pair" : "field-row"}">${selectField("Downlink strategy", "downlinkStrategy", object.downlinkStrategy, [["compareToUplinkObject", "Compare with the following BACnet uplink object"], ["compareToUplinkObjectWithinRange", "Compare with the following BACnet uplink object within range"], ["onChangeOfThisValue", "On change on BMS"], ["onChangeOfThisValueWithinRange", "On change on BMS within range"]])}${object.downlinkStrategy?.startsWith("compareToUplinkObject") ? selectField("Uplink BACnet object name", "uplinkToCompareWith", object.uplinkToCompareWith || "", uplinkObjectOptions) : ""}</div>
      ${object.downlinkStrategy?.endsWith("WithinRange") ? `<div class="field-row">${inputField("Range minimum", "range.0", range[0], { type: "number", step: "any" })}</div><div class="field-row">${inputField("Range maximum", "range.1", range[1], { type: "number", step: "any" })}</div>` : ""}
      <div class="field-row">${selectField("Priority", "downlinkPortPriority", object.downlinkPortPriority || "low", [["low", "Low"], ["high", "High"]])}</div>
      <div class="field-row">${object.objectType === "binaryValue" ? selectField("Default value when the object is created", "value", object.value ?? 0, [["0", "0 / inactive"], ["1", "1 / active"]]) : inputField("Default value when the object is created", "value", object.value ?? 0, { type: "number", step: "any" })}</div>
    </div>` : "";

  return `<article class="object-card${objectExpanded ? " is-expanded" : ""}" data-object-card="${escapeHtml(name)}">
    <div class="object-card-heading">
      <button class="panel-toggle object-panel-toggle" type="button" data-panel-toggle="object" data-object-name="${escapeHtml(name)}" aria-expanded="${objectExpanded}">
        <span class="panel-chevron" aria-hidden="true">${objectExpanded ? "−" : "+"}</span>
        <span class="object-title"><span class="object-type-mark ${downlink ? "mark-down" : "mark-up"}" aria-hidden="true">${downlink ? "↓" : "↑"}</span><span class="object-title-copy"><strong>${escapeHtml(name)}</strong><small>${downlink ? "Downlink object" : "Uplink object"}</small></span></span>
        <span class="panel-summary-count">${escapeHtml(object.objectType === "binaryValue" ? "Binary value" : "Analog value")}</span>
      </button>
      <button class="button button-danger-quiet button-compact" type="button" data-action="delete-object" data-object-name="${escapeHtml(name)}">Remove</button>
    </div>
    <div class="object-card-body"${objectExpanded ? "" : " hidden"}>
      <div class="field-grid">${core.join("")}</div>${downlinkFields}
    </div>
  </article>`;
}

function render() {
  renderNavigation();
  renderGlobal();
  renderDevice();
  const showingGlobal = state.selectedView === "global";
  const showingMqtt = state.selectedView === "mqtt";
  const showingLog = state.selectedView === "log";
  $(".global-section").hidden = !showingGlobal;
  $("#device-editor").hidden = showingGlobal || showingMqtt || showingLog;
  $("#mqtt-section").hidden = !showingMqtt;
  $("#log-section").hidden = !showingLog;
  $("#page-title").textContent = showingGlobal
    ? (state.selectedConnection || "BMS connections")
    : showingMqtt ? "MQTT connection" : showingLog ? "Message log" : "Device configuration";
  $("#page-description").textContent = showingGlobal
    ? "Reusable settings that can be assigned to device types."
    : showingMqtt ? "Subscribe to uplink messages and inspect the raw MQTT traffic."
      : showingLog ? "Incoming packets and the mapped device output."
        : "Device fleet settings and BACnet object mapping.";
}

function showNotice(message, kind = "success") {
  const notice = $("#notice");
  notice.textContent = message;
  notice.className = `notice notice-${kind}`;
  notice.hidden = false;
  clearTimeout(state.noticeTimer);
  state.noticeTimer = setTimeout(() => { notice.hidden = true; }, 5000);
}

function inputValue(input) {
  if (input.type === "number") return input.value === "" ? "" : Number(input.value);
  return input.value;
}

function renameDevice(oldName, newName) {
  const safeName = newName;
  if (/\s/.test(safeName)) {
    showNotice("Device type names cannot contain spaces.", "error");
    render();
    return;
  }
  if (!safeName || (safeName !== oldName && Object.hasOwn(state.config.deviceList, safeName))) {
    showNotice("Device type names must be unique and cannot be empty.", "error");
    render();
    return;
  }
  if (safeName !== oldName) {
    state.config.deviceList[safeName] = state.config.deviceList[oldName];
    delete state.config.deviceList[oldName];
    state.config.deviceConnections[safeName] = state.config.deviceConnections[oldName] || "";
    state.config.deviceList[safeName].controller.connectionName = state.config.deviceConnections[safeName];
    delete state.config.deviceConnections[oldName];
    state.expandedDevices[safeName] = state.expandedDevices[oldName] || false;
    delete state.expandedDevices[oldName];
    for (const [key, expanded] of Object.entries(state.expandedObjects)) {
      if (key.startsWith(`${oldName}::`)) {
        state.expandedObjects[`${safeName}::${key.slice(oldName.length + 2)}`] = expanded;
        delete state.expandedObjects[key];
      }
    }
    state.selectedDevice = safeName;
  }
}

function renameConnection(oldName, newName) {
  const safeName = newName.trim();
  if (!safeName || (safeName !== oldName && Object.hasOwn(state.config.connections, safeName))) {
    showNotice("Connection names must be unique and cannot be empty.", "error");
    render();
    return;
  }
  if (safeName !== oldName) {
    state.config.connections[safeName] = state.config.connections[oldName];
    delete state.config.connections[oldName];
    for (const deviceName of Object.keys(state.config.deviceConnections)) {
      if (state.config.deviceConnections[deviceName] === oldName) state.config.deviceConnections[deviceName] = safeName;
      if (state.config.deviceList[deviceName]?.controller) state.config.deviceList[deviceName].controller.connectionName = state.config.deviceConnections[deviceName];
    }
    state.selectedConnection = safeName;
  }
}

function renameObject(device, oldName, newName) {
  const safeName = newName;
  if (/\s/.test(safeName)) {
    showNotice("Object names cannot contain spaces.", "error");
    render();
    return;
  }
  if (!safeName || (safeName !== oldName && Object.hasOwn(device.bacnet.objects, safeName))) {
    showNotice("Object names must be unique and cannot be empty.", "error");
    render();
    return;
  }
  if (safeName !== oldName) {
    device.bacnet.objects[safeName] = device.bacnet.objects[oldName];
    delete device.bacnet.objects[oldName];
    const oldKey = `${state.selectedDevice}::${oldName}`;
    const newKey = `${state.selectedDevice}::${safeName}`;
    state.expandedObjects[newKey] = state.expandedObjects[oldKey] || false;
    delete state.expandedObjects[oldKey];
  }
}

function syncAssignedConnections() {
  for (const [deviceName, device] of Object.entries(state.config.deviceList)) {
    const connection = state.config.connections[state.config.deviceConnections[deviceName]];
    applyConnection(device, connection, state.config.deviceConnections[deviceName] || "");
  }
}

function setConnectionValue(path, value) {
  const connection = state.config.connections[state.selectedConnection];
  if (!connection) return;
  setPath(connection, path, value);
  applyConnectionToAssignedDevices(state.selectedConnection);
  render();
}

function downloadConfig() {
  syncAssignedConnections();
  const blob = new Blob([`${JSON.stringify(state.config.deviceList, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "deviceList.json";
  link.click();
  URL.revokeObjectURL(url);
}

async function saveConfig() {
  syncAssignedConnections();
  const response = await fetch("/api/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.config)
  });
  const result = await response.json();
  if (!response.ok) {
    showNotice(result.errors?.map((error) => `${error.path}: ${error.message}`).join(" | ") || result.error, "error");
    return;
  }
  const mqttSaved = await saveMqttSettings();
  showNotice(mqttSaved ? "Device list and MQTT connection saved to this server." : "Device list saved, but the MQTT connection could not be saved.", mqttSaved ? undefined : "error");
}

async function loadConfig() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error("Configuration endpoint unavailable");
    state.config = await response.json();
    state.config.connections ||= {};
    state.config.deviceConnections ||= {};
    state.config.deviceList ||= {};
    for (const deviceName of Object.keys(state.config.deviceList)) state.config.deviceConnections[deviceName] ||= "";
  } catch (error) {
    state.config = defaultConfig();
    showNotice("The server could not be reached. Changes will not persist until it is running.", "error");
  }
  render();
}

function setMqttStatus(status) {
  const connectionState = status.state || "disconnected";
  const labels = { connected: "Connected", connecting: "Connecting", error: "Connection error", disconnected: "Disconnected" };
  const headerLabel = connectionState === "disconnected" ? "MQTT offline" : `MQTT ${labels[connectionState] || connectionState}`;
  const dotClass = connectionState === "connected" ? "state-dot-connected"
    : connectionState === "connecting" ? "state-dot-connecting" : "state-dot-offline";
  const header = $("#mqtt-state");
  const dot = document.createElement("span");
  dot.className = `state-dot ${dotClass}`;
  header.replaceChildren(dot, document.createTextNode(headerLabel));
  $("#mqtt-section-state").textContent = labels[connectionState] || connectionState;
  $("#mqtt-nav-status").textContent = labels[connectionState] || connectionState;
  $("#mqtt-nav-dot").classList.toggle("is-connected", connectionState === "connected");
  $("#mqtt-connect-button").disabled = connectionState === "connecting" || connectionState === "connected";
  $("#mqtt-disconnect-button").disabled = connectionState === "disconnected";
}

function appendMqttLog(entry) {
  const log = $("#mqtt-log");
  const row = document.createElement("article");
  row.className = `mqtt-log-entry mqtt-log-${entry.level}`;
  const meta = document.createElement("div");
  meta.className = "mqtt-log-meta";
  const level = document.createElement("span");
  level.className = "mqtt-log-level";
  level.textContent = entry.level;
  const timestamp = document.createElement("time");
  timestamp.dateTime = entry.timestamp;
  timestamp.textContent = new Date(entry.timestamp).toLocaleTimeString();
  meta.append(level, timestamp);
  const message = document.createElement("pre");
  message.className = "mqtt-log-message";
  message.textContent = entry.message;
  row.append(meta, message, createCopyButton(() => `${entry.level} ${entry.timestamp}\n${entry.message}`));
  prependLogRow(log, row, $("#mqtt-log-count"));
}

function createCopyButton(getText) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mqtt-copy-button";
  button.title = "Copy";
  button.setAttribute("aria-label", "Copy log entry");
  button.textContent = "⧉";
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getText());
      button.textContent = "✓";
    } catch {
      button.textContent = "!";
    }
    setTimeout(() => { button.textContent = "⧉"; }, 1200);
  });
  return button;
}

function appendRawMqttMessage(entry) {
  const log = $("#mqtt-raw-log");
  const row = document.createElement("article");
  row.className = "mqtt-log-entry mqtt-raw-entry";
  const meta = document.createElement("div");
  meta.className = "mqtt-log-meta";
  const timestamp = document.createElement("time");
  timestamp.dateTime = entry.timestamp;
  timestamp.textContent = new Date(entry.timestamp).toLocaleTimeString();
  const topic = document.createElement("span");
  topic.className = "mqtt-log-topic";
  topic.textContent = entry.topic;
  meta.append(timestamp, topic);
  const message = document.createElement("pre");
  message.className = "mqtt-log-message";
  message.textContent = entry.payload;
  row.append(meta, message, createCopyButton(() => `${entry.topic}\n${entry.payload}`));
  prependLogRow(log, row, $("#mqtt-raw-count"));
}

function prependLogRow(log, row, counter) {
  log.querySelector(".mqtt-log-empty")?.remove();
  log.prepend(row);
  while (log.children.length > 300) log.lastElementChild.remove();
  counter.textContent = `${log.querySelectorAll(".mqtt-log-entry").length} entries`;
  log.scrollTop = 0;
}

function clearLog(logId) {
  const log = $(`#${logId}`);
  log.innerHTML = `<div class="mqtt-log-empty">${logId === "mqtt-raw-log" ? "No raw MQTT messages yet." : "No MQTT activity yet."}</div>`;
  $(logId === "mqtt-raw-log" ? "#mqtt-raw-count" : "#mqtt-log-count").textContent = "0 entries";
}

function readMqttForm() {
  return {
    server: $("#mqtt-server").value,
    port: $("#mqtt-port").value,
    username: $("#mqtt-username").value,
    password: $("#mqtt-password").value,
    topic: $("#mqtt-topic").value,
    autoConnect: $("#mqtt-auto-connect").checked
  };
}

async function saveMqttSettings() {
  try {
    const response = await fetch("/api/mqtt/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(readMqttForm())
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function loadMqttSettings() {
  try {
    const response = await fetch("/api/mqtt/settings");
    if (!response.ok) return;
    const settings = await response.json();
    for (const field of ["server", "port", "username", "password", "topic"]) {
      if (settings[field]) $(`#mqtt-${field}`).value = settings[field];
    }
    $("#mqtt-auto-connect").checked = settings.autoConnect === true;
  } catch {
    // Saved settings are optional.
  }
}

async function connectMqtt() {
  const settings = readMqttForm();
  await saveMqttSettings();
  try {
    const response = await fetch("/api/mqtt/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to connect to the MQTT broker.");
    setMqttStatus(result);
    await refreshMqtt();
  } catch (error) {
    showNotice(error.message, "error");
  }
}

async function disconnectMqtt() {
  try {
    const response = await fetch("/api/mqtt/disconnect", { method: "POST" });
    if (!response.ok) throw new Error("Unable to disconnect from the MQTT broker.");
    setMqttStatus(await response.json());
  } catch (error) {
    showNotice(error.message, "error");
  }
}

async function refreshMqtt() {
  try {
    const [statusResponse, logsResponse, rawResponse] = await Promise.all([
      fetch("/api/mqtt/status"),
      fetch(`/api/mqtt/logs?after=${state.mqttLogId}`),
      fetch(`/api/mqtt/raw?after=${state.mqttRawId}`)
    ]);
    if (!statusResponse.ok || !logsResponse.ok || !rawResponse.ok) return;
    setMqttStatus(await statusResponse.json());
    const result = await logsResponse.json();
    for (const entry of state.paused.log ? [] : result.entries) {
      appendMqttLog(entry);
      state.mqttLogId = entry.id;
    }
    for (const entry of state.paused.raw ? [] : (await rawResponse.json()).entries) {
      appendRawMqttMessage(entry);
      state.mqttRawId = entry.id;
    }
  } catch {
    setMqttStatus({ state: "disconnected" });
  }
}

document.addEventListener("change", (event) => {
  const input = event.target;
  if (input.matches("#global-form [data-connection-field]")) {
    setConnectionValue(input.dataset.connectionField, inputValue(input));
    return;
  }
  if (input.matches("#connection-name")) {
    renameConnection(state.selectedConnection, input.value);
    render();
    return;
  }

  const device = state.config.deviceList[state.selectedDevice];
  if (!device) return;
  if (input.matches("#device-editor [data-device-connection]")) {
    const connectionName = input.value;
    state.config.deviceConnections[state.selectedDevice] = connectionName;
    applyConnection(device, state.config.connections[connectionName], connectionName);
    render();
    return;
  }
  if (input.matches("#device-editor [data-debug]")) {
    const key = input.dataset.debug;
    const debug = device.controller.debug || [];
    if (key === "all") {
      device.controller.debug = debug.filter((item) => item !== "all");
      if (input.checked) device.controller.debug.push("all");
    } else {
      device.controller.debug = debug.slice();
      if (input.checked) device.controller.debug.push(key);
      else device.controller.debug = device.controller.debug.filter((item) => item !== key);
    }
    renderDevice();
    return;
  }

  if (input.matches("#device-editor [data-path]")) {
    const card = input.closest("[data-object-card]");
    if (input.dataset.path === "_name" && card) {
      renameObject(device, card.dataset.objectCard, inputValue(input));
      render();
      return;
    }
    if (input.dataset.path === "_name") {
      renameDevice(state.selectedDevice, inputValue(input));
      render();
      return;
    }
    const objectName = card?.dataset.objectCard;
    const target = objectName ? device.bacnet.objects[objectName] : device;
    const value = inputValue(input);
    if (input.dataset.path === "lorawanPayloadName" && /\s/.test(value)) {
      showNotice("LoRaWAN payload names cannot contain spaces.", "error");
      render();
      return;
    }
    setPath(target, input.dataset.path, input.type === "checkbox" ? input.checked : value);
    if (input.dataset.path === "dataDirection") {
      applyConnection(device, state.config.connections[state.config.deviceConnections[state.selectedDevice]], state.config.deviceConnections[state.selectedDevice]);
      render();
      return;
    }
    if (["objectType", "assignementMode", "downlinkStrategy"].includes(input.dataset.path)) renderDevice();
  }
});

document.addEventListener("click", async (event) => {
  const clearButton = event.target.closest("[data-clear-log]");
  if (clearButton) clearLog(clearButton.dataset.clearLog);
  const toggleButton = event.target.closest("[data-toggle-log]");
  if (toggleButton) {
    const key = toggleButton.dataset.toggleLog;
    state.paused[key] = !state.paused[key];
    toggleButton.textContent = state.paused[key] ? "Resume" : "Suspend";
  }
  if (event.target.closest("#mqtt-connect-button")) {
    await connectMqtt();
    return;
  }
  if (event.target.closest("#mqtt-disconnect-button")) {
    await disconnectMqtt();
    return;
  }

  const panelToggle = event.target.closest("[data-panel-toggle]");
  if (panelToggle) {
    const expanded = panelToggle.getAttribute("aria-expanded") !== "true";
    panelToggle.setAttribute("aria-expanded", String(expanded));
    panelToggle.querySelector(".panel-chevron").textContent = expanded ? "−" : "+";
    if (panelToggle.dataset.panelToggle === "device") {
      state.expandedDevices[state.selectedDevice] = expanded;
      $("#device-config-panel").hidden = !expanded;
      panelToggle.closest(".device-card").classList.toggle("is-expanded", expanded);
    } else {
      const objectName = panelToggle.dataset.objectName;
      const objectKey = `${state.selectedDevice}::${objectName}`;
      state.expandedObjects[objectKey] = expanded;
      panelToggle.closest(".object-card").querySelector(".object-card-body").hidden = !expanded;
      panelToggle.closest(".object-card").classList.toggle("is-expanded", expanded);
    }
    return;
  }

  const selectButton = event.target.closest("[data-select-device]");
  if (selectButton) {
    state.selectedDevice = selectButton.dataset.selectDevice;
    state.selectedView = "device";
    render();
    return;
  }

  const viewButton = event.target.closest("[data-select-view]");
  if (viewButton) {
    state.selectedView = viewButton.dataset.selectView;
    render();
    return;
  }

  const connectionButton = event.target.closest("[data-select-connection]");
  if (connectionButton) {
    state.selectedConnection = connectionButton.dataset.selectConnection;
    state.selectedView = "global";
    render();
    return;
  }

  const actionButton = event.target.closest("[data-action]");
  if (actionButton) {
    const device = state.config.deviceList[state.selectedDevice];
    switch (actionButton.dataset.action) {
      case "add-device": {
        const base = "loraDevice";
        let index = 0;
        const letters = (n) => (n >= 26 ? letters(Math.floor(n / 26) - 1) : "") + String.fromCharCode(65 + (n % 26));
        while (Object.hasOwn(state.config.deviceList, `${base}${letters(index)}`)) index += 1;
        const name = `${base}${letters(index)}`;
        const connectionName = state.selectedConnection || Object.keys(state.config.connections)[0] || "";
        state.config.deviceList[name] = makeDevice(name, connectionName);
        state.expandedDevices[name] = true;
        state.selectedDevice = name;
        state.selectedView = "device";
        break;
      }
      case "delete-device":
        if (device && confirm(`Remove device type '${state.selectedDevice}' and its objects?`)) {
          delete state.config.deviceList[state.selectedDevice];
          delete state.config.deviceConnections[state.selectedDevice];
          delete state.expandedDevices[state.selectedDevice];
          for (const key of Object.keys(state.expandedObjects)) {
            if (key.startsWith(`${state.selectedDevice}::`)) delete state.expandedObjects[key];
          }
          state.selectedDevice = Object.keys(state.config.deviceList)[0] || null;
        }
        break;
      case "add-connection": {
        let index = 1;
        while (Object.hasOwn(state.config.connections, `Connection ${index}`)) index += 1;
        const connectionName = `Connection ${index}`;
        state.config.connections[connectionName] = defaultConnection();
        state.selectedConnection = connectionName;
        state.selectedView = "global";
        break;
      }
      case "delete-connection":
        if (state.selectedConnection && confirm(`Remove connection '${state.selectedConnection}'? Assigned devices will keep their current settings.`)) {
          const removedName = state.selectedConnection;
          delete state.config.connections[removedName];
          for (const deviceName of Object.keys(state.config.deviceConnections)) {
            if (state.config.deviceConnections[deviceName] === removedName) {
              state.config.deviceConnections[deviceName] = "";
              if (state.config.deviceList[deviceName]?.controller) state.config.deviceList[deviceName].controller.connectionName = "";
            }
          }
          state.selectedConnection = Object.keys(state.config.connections)[0] || null;
        }
        break;
      case "add-object": {
        const base = "object";
        let index = 1;
        while (Object.hasOwn(device.bacnet.objects, `${base}-${index}`)) index += 1;
        const objectName = `${base}-${index}`;
        device.bacnet.objects[objectName] = makeObject();
        state.expandedObjects[`${state.selectedDevice}::${objectName}`] = true;
        break;
      }
      case "delete-object":
        delete device.bacnet.objects[actionButton.dataset.objectName];
        delete state.expandedObjects[`${state.selectedDevice}::${actionButton.dataset.objectName}`];
        applyConnection(device, state.config.connections[state.config.deviceConnections[state.selectedDevice]], state.config.deviceConnections[state.selectedDevice]);
        break;
      default:
        return;
    }
    render();
    return;
  }

  if (event.target.closest("#save-button")) await saveConfig();
  if (event.target.closest("#export-button")) downloadConfig();
  if (event.target.closest("#import-button")) $("#import-file").click();
  if (event.target.closest("#edit-json-button")) {
    $("#json-input").value = JSON.stringify(state.config.deviceList, null, 2);
    $("#json-errors").hidden = true;
    $("#json-dialog").showModal();
  }
  if (event.target.closest("#apply-json-button")) {
    try {
        const imported = JSON.parse($("#json-input").value);
      if (!imported || typeof imported !== "object" || Array.isArray(imported)) throw new Error("Device list must be a JSON object.");
        const importedConnections = rebuildConnectionsFromDeviceList(imported);
        const candidate = { ...state.config, ...importedConnections, deviceList: imported };
      const response = await fetch("/api/config/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(candidate) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.errors.map((item) => `${item.path}: ${item.message}`).join("\n"));
      state.config.deviceList = imported;
      state.config.connections = importedConnections.connections;
      state.config.deviceConnections = importedConnections.deviceConnections;
      state.expandedDevices = {};
      state.expandedObjects = {};
      state.selectedDevice = Object.keys(imported)[0] || null;
      state.selectedView = "device";
      $("#json-dialog").close();
      render();
      showNotice("Device list JSON applied.");
    } catch (error) {
      $("#json-errors").textContent = error.message;
      $("#json-errors").hidden = false;
    }
  }
});

$("#import-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const importedList = parsed.deviceList || parsed;
    if (!importedList || typeof importedList !== "object" || Array.isArray(importedList)) throw new Error("Expected a device-list JSON object.");
    const importedConnections = rebuildConnectionsFromDeviceList(importedList);
    state.config.deviceList = importedList;
    state.config.connections = importedConnections.connections;
    state.config.deviceConnections = importedConnections.deviceConnections;
    state.expandedDevices = {};
    state.expandedObjects = {};
    state.selectedDevice = Object.keys(importedList)[0] || null;
    state.selectedView = "device";
    render();
    showNotice("JSON imported. Save to persist this configuration.");
  } catch (error) {
    showNotice(`Import failed: ${error.message}`, "error");
  }
  event.target.value = "";
});

loadConfig();
loadMqttSettings();
clearLog("mqtt-log");
clearLog("mqtt-raw-log");
refreshMqtt();
setInterval(refreshMqtt, 1200);