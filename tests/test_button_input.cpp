#include "../firmware/AgentCompanion/src/ButtonInput.h"
#include <cassert>
#include <iostream>

int main() {
  using copilot::kButtonDebounceMs;
  copilot::ButtonPressTracker button;
  // Held at startup: no press until it is released and pressed again.
  assert(!button.sample(true, 0));
  assert(!button.sample(true, 500));
  assert(!button.sample(false, 600));
  assert(!button.sample(false, 600 + kButtonDebounceMs));

  // A press counts once, after it stays down for the debounce time.
  assert(!button.sample(true, 1000));
  assert(!button.sample(true, 1000 + kButtonDebounceMs - 1));
  assert(button.sample(true, 1000 + kButtonDebounceMs));
  assert(!button.sample(true, 1000 + kButtonDebounceMs + 1));
  assert(!button.sample(true, 5000));

  // Contact bounce on release and on the next press gives no extra presses.
  assert(!button.sample(false, 6000));
  assert(!button.sample(true, 6005));
  assert(!button.sample(false, 6010));
  assert(!button.sample(false, 6010 + kButtonDebounceMs));
  assert(!button.sample(true, 7000));
  assert(!button.sample(false, 7004));
  assert(!button.sample(true, 7008));
  assert(button.sample(true, 7008 + kButtonDebounceMs));

  // A glitch shorter than the debounce time is not a press.
  assert(!button.sample(false, 8000));
  assert(!button.sample(false, 8000 + kButtonDebounceMs));
  assert(!button.sample(true, 9000));
  assert(!button.sample(false, 9000 + kButtonDebounceMs / 2));
  assert(!button.sample(false, 9000 + kButtonDebounceMs * 2));

  // The millisecond counter can wrap.
  copilot::ButtonPressTracker wrapping;
  assert(!wrapping.sample(false, 0xFFFFFFF0u));
  assert(!wrapping.sample(false, 0xFFFFFFF0u + kButtonDebounceMs));
  assert(!wrapping.sample(true, 0xFFFFFFFAu));
  assert(wrapping.sample(true, 0xFFFFFFFAu + kButtonDebounceMs));
  std::cout << "button input tests passed\n";
}
