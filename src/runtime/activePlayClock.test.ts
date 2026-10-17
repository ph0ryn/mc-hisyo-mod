import { expect, test } from "vite-plus/test";
import { ActivePlayClock } from "./activePlayClock.js";

test("reserves one poll after 60 seconds of active monotonic time", () => {
  const clock = new ActivePlayClock();
  clock.setPlaying(true, 1000);
  expect(clock.poll(60_999)).toBe(false);
  expect(clock.poll(61_000)).toBe(true);
  expect(clock.poll(61_000)).toBe(false);
  expect(clock.poll(120_999)).toBe(false);
  expect(clock.poll(121_000)).toBe(true);
});

test("excludes paused time while preserving the active fraction", () => {
  const clock = new ActivePlayClock();
  clock.setPlaying(true, 0);
  clock.setPlaying(false, 25_000);
  expect(clock.poll(1_000_000)).toBe(false);
  clock.setPlaying(true, 2_000_000);
  expect(clock.poll(2_034_999)).toBe(false);
  expect(clock.poll(2_035_000)).toBe(true);
});

test("does not count time before play or reset elapsed on duplicate status", () => {
  const clock = new ActivePlayClock();
  expect(clock.poll(100_000)).toBe(false);
  clock.setPlaying(false, 200_000);
  clock.setPlaying(true, 300_000);
  clock.setPlaying(true, 330_000);
  expect(clock.poll(360_000)).toBe(true);
});

test("a late sample coalesces missed intervals without a catch-up burst", () => {
  const clock = new ActivePlayClock();
  clock.setPlaying(true, 0);
  expect(clock.poll(210_000)).toBe(true);
  expect(clock.poll(210_000)).toBe(false);
  expect(clock.poll(269_999)).toBe(false);
  expect(clock.poll(270_000)).toBe(true);
});

test("an interval reached just before pause stays due only once on resume", () => {
  const clock = new ActivePlayClock();
  clock.setPlaying(true, 0);
  clock.setPlaying(false, 60_000);
  expect(clock.poll(600_000)).toBe(false);
  clock.setPlaying(true, 700_000);
  expect(clock.poll(700_000)).toBe(true);
  expect(clock.poll(700_000)).toBe(false);
});

test.each([NaN, Infinity, -Infinity, -1])("rejects invalid monotonic sample %s", (now) => {
  const clock = new ActivePlayClock();
  expect(() => clock.setPlaying(true, now)).toThrow("Invalid monotonic time");
  expect(() => clock.poll(now)).toThrow("Invalid monotonic time");
  clock.setPlaying(true, 0);
  expect(clock.poll(60_000)).toBe(true);
});

test("rejects backwards time without changing accumulated elapsed time", () => {
  const clock = new ActivePlayClock();
  clock.setPlaying(true, 100);
  expect(clock.poll(30_100)).toBe(false);
  expect(() => clock.setPlaying(false, 30_099)).toThrow("Invalid monotonic time");
  expect(() => clock.poll(30_099)).toThrow("Invalid monotonic time");
  expect(clock.poll(60_100)).toBe(true);
});
