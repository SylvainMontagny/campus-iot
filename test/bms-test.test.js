const test = require("node:test");
const assert = require("node:assert/strict");
const { ServicesSupported } = require("@bacnet-js/client");
const { testBmsConnection } = require("../src/bms-test");

function servicesBitstring(...services) {
  const value = new Array(7).fill(0);
  for (const service of services) value[service >> 3] |= 1 << (service & 7);
  return { value, bitsUsed: 49 };
}

function clientWith(services) {
  return {
    readProperty: async (address, id, property) => {
      if (id.type === 8) {
        if (services instanceof Error) throw services;
        return { values: [{ type: 8, value: services }] };
      }
      throw new Error("BacnetError - Class:1 - Code:31");
    },
    close() {}
  };
}

const run = (client) => testBmsConnection({ protocol: "bacnet", ipAddress: "10.0.0.9" }, { bacnet: { createClient: async () => client } });

test("a BMS supporting CreateObject and DeleteObject gives a plain success", async () => {
  const bitstring = servicesBitstring(ServicesSupported.CREATE_OBJECT, ServicesSupported.DELETE_OBJECT);
  assert.equal(await run(clientWith(bitstring)), "BMS connected (BACnet)");
});

test("a BMS without CreateObject or DeleteObject warns about the Read/Write Property limitation", async () => {
  const result = await run(clientWith(servicesBitstring(ServicesSupported.READ_PROPERTY, ServicesSupported.WRITE_PROPERTY)));
  assert.equal(result.message, "BMS connected (BACnet)");
  assert.match(result.warning, /CreateObject and DeleteObject/);
  assert.doesNotMatch(result.warning, /only Read and Write Property/);
});

test("only the missing service is named", async () => {
  const result = await run(clientWith(servicesBitstring(ServicesSupported.CREATE_OBJECT)));
  assert.match(result.warning, /\(DeleteObject not supported/);
});

test("unreadable supported services do not turn a working connection into a warning", async () => {
  assert.equal(await run(clientWith(new Error("BacnetError - Class:2 - Code:32"))), "BMS connected (BACnet)");
});
