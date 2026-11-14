// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createSessionScrollFollow } from "./session-scroll-follow";

function position(y: number, height = 2000, viewport = 600) {
  return {
    contentOffset: { y },
    contentSize: { height },
    layoutMeasurement: { height: viewport },
  };
}

describe("AI session scroll following", () => {
  it("follows initially and pauses before the first drag scroll event", () => {
    const follow = createSessionScrollFollow();
    expect(follow.following).toBe(true);
    follow.beginDrag(position(1400));
    expect(follow.following).toBe(false);
  });

  it("keeps slow, segmented upward drags paused while streaming grows the list", () => {
    const follow = createSessionScrollFollow();
    let height = 2000;
    let y = 1400;
    for (let step = 0; step < 10; step++) {
      follow.beginDrag(position(y, height));
      y -= 30;
      follow.scroll(position(y, height));
      height += 40;
      follow.scroll(position(y, height));
      follow.endDrag({ ...position(y, height), velocity: { y: 0 } });
      expect(follow.following).toBe(false);
    }
  });

  it("does not let an earlier programmatic scroll ending during a drag restore following", () => {
    const follow = createSessionScrollFollow();
    follow.beginDrag(position(1400));
    follow.endMomentum(position(1400));
    expect(follow.following).toBe(false);
    follow.endDrag({ ...position(1370), velocity: { y: 0 } });
    expect(follow.following).toBe(false);
  });

  it("does not resume after an upward movement even within the bottom tolerance", () => {
    const follow = createSessionScrollFollow();
    follow.beginDrag(position(1400));
    follow.endDrag({ ...position(1399), velocity: { y: 0 } });
    expect(follow.following).toBe(false);
  });

  it("resumes only after a downward drag reaches the bottom and ends", () => {
    const follow = createSessionScrollFollow();
    follow.pause();
    follow.beginDrag(position(1000));
    follow.scroll(position(1399));
    expect(follow.following).toBe(false);
    follow.endDrag({ ...position(1399), velocity: { y: 0 } });
    expect(follow.following).toBe(true);
  });

  it("does not resume a downward drag that stops inside the former 100px threshold", () => {
    const follow = createSessionScrollFollow();
    follow.beginDrag(position(1000));
    follow.endDrag({ ...position(1370), velocity: { y: 0 } });
    expect(follow.following).toBe(false);
  });

  it("stays paused through momentum and resumes when user deceleration reaches the bottom", () => {
    const follow = createSessionScrollFollow();
    follow.beginDrag(position(1000));
    follow.endDrag({ ...position(1300), velocity: { y: 1 } });
    follow.scroll(position(1400));
    expect(follow.following).toBe(false);
    follow.endMomentum(position(1400));
    expect(follow.following).toBe(true);
  });

  it.each(["scroll", "release", "momentum"] as const)(
    "resumes when streamed growth and the user's return to the bottom coincide at %s",
    (stage) => {
      const follow = createSessionScrollFollow();
      follow.pause();
      follow.beginDrag(position(1000));
      follow.scroll(position(1300));
      const bottom = position(1440, 2040);
      if (stage === "scroll") {
        follow.scroll(bottom);
        expect(follow.following).toBe(false);
        follow.endDrag({ ...bottom, velocity: { y: 0 } });
      } else if (stage === "release") {
        follow.endDrag({ ...bottom, velocity: { y: 0 } });
      } else {
        follow.endDrag({ ...position(1300), velocity: { y: 1 } });
        follow.endMomentum(bottom);
      }
      expect(follow.following).toBe(true);
    },
  );

  it("preserves an intentional return when growth only shifts the bottom before release", () => {
    const follow = createSessionScrollFollow();
    follow.beginDrag(position(1000));
    follow.scroll(position(1400));
    follow.endDrag({ ...position(1440, 2040), velocity: { y: 0 } });
    expect(follow.following).toBe(true);
  });

  it("does not restore following from content growth and equal anchoring displacement", () => {
    const follow = createSessionScrollFollow();
    follow.beginDrag(position(1000));
    follow.scroll(position(1300));
    follow.endDrag({ ...position(1340, 2040), velocity: { y: 0 } });
    expect(follow.following).toBe(false);
  });

  it("keeps upward momentum paused despite streamed content and later programmatic scrolling", () => {
    const follow = createSessionScrollFollow();
    follow.beginDrag(position(1400));
    follow.endDrag({ ...position(1370), velocity: { y: -1 } });
    follow.scroll(position(1200, 2040));
    follow.endMomentum(position(1100, 2080));
    follow.scroll(position(1480, 2080));
    follow.endMomentum(position(1480, 2080));
    expect(follow.following).toBe(false);
  });

  it.each([
    ["keyboard opening", position(1600, 2000, 400)],
    ["keyboard closing", position(1200, 2000, 800)],
    ["history prepend", position(1700, 2400)],
    ["content shrinking", position(1000, 1600)],
  ])("does not treat %s during a drag as intentionally returning to the bottom", (_name, resized) => {
    const follow = createSessionScrollFollow();
    follow.beginDrag(position(1300));
    follow.scroll(resized);
    follow.endDrag({ ...resized, velocity: { y: 0 } });
    expect(follow.following).toBe(false);
  });

  it("allows bottom rubber-banding to settle without mistaking the bounce for an upward drag", () => {
    const follow = createSessionScrollFollow();
    follow.beginDrag(position(1300));
    follow.scroll(position(1430));
    follow.endDrag({ ...position(1420), velocity: { y: 1 } });
    follow.endMomentum(position(1400));
    expect(follow.following).toBe(true);
  });

  it("resumes at a fractional native bottom after rubber-banding", () => {
    const follow = createSessionScrollFollow();
    const nativePosition = (y: number) =>
      position(y, 10754.6669921875, 632.6666666666666);
    follow.beginDrag(nativePosition(10100));
    follow.endDrag({ ...nativePosition(10144.333333333334), velocity: { y: 0.124 } });
    follow.scroll(nativePosition(10122.666666666666));
    follow.endMomentum(nativePosition(10122));
    expect(follow.following).toBe(true);
  });

  it("keeps history loading or turn navigation paused even when a programmatic animation ends at the bottom", () => {
    const follow = createSessionScrollFollow();
    follow.beginDrag(position(1300));
    follow.pause();
    follow.scroll(position(1400));
    follow.endMomentum(position(1400));
    expect(follow.following).toBe(false);
  });

  it("the Latest action resumes immediately and discards an unfinished user gesture", () => {
    const follow = createSessionScrollFollow();
    follow.beginDrag(position(1400));
    follow.scroll(position(1300));
    follow.resume();
    follow.scroll(position(1400));
    follow.endMomentum(position(1400));
    expect(follow.following).toBe(true);
  });

  it("does not mistake content growth or viewport changes for an intent to stop following", () => {
    const follow = createSessionScrollFollow();
    follow.scroll(position(1400, 2500, 400));
    expect(follow.following).toBe(true);
  });
});
