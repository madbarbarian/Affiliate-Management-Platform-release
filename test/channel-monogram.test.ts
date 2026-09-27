import assert from "node:assert/strict";
import { test } from "node:test";

import {
  channelMonogram,
  isKnownChannel,
  KNOWN_CHANNEL_MONOGRAMS,
  UNKNOWN_CHANNEL_MONOGRAM,
} from "../src/console/channel-monogram.ts";

// visual-polish-proposal.md §4.2: threads -> T, x -> X, note -> n,
// youtube -> YT, by-hand -> 手. Every known id gets its own case so a channel
// added to the table without a matching letter check here still leaves the
// others green - the point of the exercise is to notice the one that changed.
test("channelMonogram: every known channel id gets the letter the proposal names", () => {
  assert.equal(channelMonogram("threads"), "T");
  assert.equal(channelMonogram("x"), "X");
  assert.equal(channelMonogram("note"), "n");
  assert.equal(channelMonogram("youtube"), "YT");
});

test("channelMonogram: the manual/by-hand channel gets 手, not a Roman initial", () => {
  // by-hand is the config's own id for the manual adapter
  // (platform.config.example.yaml); §4.2 chose a kanji character over "M"
  // specifically because this product's own voice is Japanese.
  assert.equal(channelMonogram("by-hand"), "手");
});

test("channelMonogram: an id this product does not ship or document falls back to the honest unknown mark", () => {
  // A licensee's own webhook destination - a Zapier scenario, a Discord relay,
  // whatever they named it - is exactly the case §4.1 says can never be told
  // apart from the genuine article by id alone, so it always gets "?".
  for (const unrecognised of ["zapier-mine", "discord", "", "Threads", "X "]) {
    assert.equal(channelMonogram(unrecognised), UNKNOWN_CHANNEL_MONOGRAM, `"${unrecognised}" was not treated as unknown`);
  }
});

test("isKnownChannel agrees with channelMonogram about which ids are known", () => {
  for (const id of Object.keys(KNOWN_CHANNEL_MONOGRAMS)) {
    assert.equal(isKnownChannel(id), true, `${id} is in the table but isKnownChannel said no`);
  }
  assert.equal(isKnownChannel("something-else"), false);
});
