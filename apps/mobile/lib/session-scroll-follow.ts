type ScrollPosition = {
  contentSize: { height: number };
  contentOffset: { y: number };
  layoutMeasurement: { height: number };
};

function offset(position: ScrollPosition) {
  const end = Math.max(
    0,
    position.contentSize.height - position.layoutMeasurement.height,
  );
  // Rubber-band motion at either edge is not a change in reading direction.
  return Math.max(0, Math.min(position.contentOffset.y, end));
}

function atBottom(position: ScrollPosition) {
  return (
    position.contentSize.height -
      position.layoutMeasurement.height -
      position.contentOffset.y <=
    2
  );
}

export function createSessionScrollFollow() {
  let following = true;
  let gesture:
    | { position: ScrollPosition; reachedBottom: boolean; dragging: boolean }
    | undefined;

  function scroll(position: ScrollPosition) {
    if (!gesture) return;
    const previous = gesture.position;
    const growth = position.contentSize.height - previous.contentSize.height;
    if (
      growth < 0 ||
      position.layoutMeasurement.height !== previous.layoutMeasurement.height
    ) {
      gesture.reachedBottom = false;
    } else {
      // Equal content growth and offset displacement only preserve the reader's
      // position. Movement beyond that displacement closes the gap to the bottom.
      const movement = offset(position) - offset(previous) - growth;
      // Native content size and offsets can round to different subpixel values.
      if (Math.abs(movement) > 0.5)
        gesture.reachedBottom = movement > 0 && atBottom(position);
      else if (growth > 0)
        gesture.reachedBottom = gesture.reachedBottom && atBottom(position);
    }
    gesture.position = position;
  }

  function settle(position: ScrollPosition) {
    scroll(position);
    if (!gesture) return;
    following = gesture.reachedBottom && atBottom(position);
    gesture = undefined;
  }

  return {
    get following() {
      return following;
    },
    pause() {
      following = false;
      gesture = undefined;
    },
    resume() {
      following = true;
      gesture = undefined;
    },
    beginDrag(position: ScrollPosition) {
      following = false;
      gesture = { position, reachedBottom: atBottom(position), dragging: true };
    },
    scroll,
    endDrag(position: ScrollPosition & { velocity?: { y: number } }) {
      scroll(position);
      if (gesture) gesture.dragging = false;
      // iOS provides release velocity; keep the gesture through deceleration.
      if (!position.velocity?.y) settle(position);
    },
    endMomentum(position: ScrollPosition) {
      // A previously dispatched scrollToEnd can finish after a drag begins.
      if (gesture && !gesture.dragging) settle(position);
    },
  };
}
