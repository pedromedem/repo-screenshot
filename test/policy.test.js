const test = require("node:test");
const assert = require("node:assert/strict");
const { isBlockedHost, partitionHomepages, selectCaptureUrls } = require("../lib/policy");

test("blocks loopback, private, and local hosts", () => {
  for (const host of ["localhost", "db.local", "127.0.0.1", "10.1.2.3", "192.168.1.9", "172.16.0.4", "169.254.1.1", "::1"]) {
    assert.equal(isBlockedHost(host), true, host);
  }
  assert.equal(isBlockedHost("172.15.0.4"), false);
  assert.equal(isBlockedHost("8.8.8.8"), false);
  assert.equal(isBlockedHost("example.com"), false);
});

test("hides internal homepages and accepts only listed urls", () => {
  const parts = partitionHomepages([
    "https://example.com/",
    "http://127.0.0.1:4000/",
    "https://shop.example/path",
  ]);
  assert.deepEqual(parts.visible, ["https://example.com/", "https://shop.example/path"]);
  assert.equal(parts.blocked.length, 1);

  assert.deepEqual(
    selectCaptureUrls(parts.visible, ["https://shop.example/path", "https://example.com"]),
    ["https://shop.example/path", "https://example.com/"]
  );
  assert.throws(
    () => selectCaptureUrls(parts.visible, ["https://evil.example/"]),
    /não está entre as homepages/
  );
  assert.throws(
    () => selectCaptureUrls(parts.visible, ["http://127.0.0.1/"]),
    /endereço interno/
  );
  assert.throws(() => selectCaptureUrls(parts.visible, []), /1 a 6/);
});
