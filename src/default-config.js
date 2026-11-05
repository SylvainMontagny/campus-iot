// Configuration storage: supplies an empty, structurally valid configuration when none has been saved yet.
function createDefaultConfig() {
  return {
    deviceProfiles: {},
    connections: {},
    deviceConnections: {}
  };
}

module.exports = { createDefaultConfig };