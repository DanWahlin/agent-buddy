#pragma once
#include "CharacterMotion.h"
#include "CharacterPack.h"
#include "FullFrameRenderer.h"
#include "SpriteRenderer.h"

namespace copilot {
// One step of the character, shared by the device (AgentCompanion.ino), the
// desktop engine (desktop/engine) and the host preview (tools/character_preview.cpp),
// so all three apply requests, keep time and pick a renderer the same way.

// A mode change as it is queued. A tap (or a click on the desktop character) is a
// Surprise like any other: after the spring it resumes the agent's Working or
// Needs attention state, or Idle when there is none.
struct ModeRequest {
  CharacterMode mode = CharacterMode::Idle;
};

// Applies a request to the motion. False when the motion reports an error.
bool applyModeRequest(CharacterMotion& motion, const ModeRequest& request);

// Advances the motion by wall-clock seconds, at the pack's motion speed. The
// device passes the header it read at start: an install unmaps the pack while
// the render task may still be stepping.
void stepCharacterMotion(CharacterMotion& motion, double seconds, const PackHeader& pack);

// Draws the pose with the renderer the loaded pack's layout needs: full-frame
// packs carry whole images, base-patch packs a base and eye patches. Effects
// are drawn separately, after this.
class CharacterSprite {
 public:
  CharacterSprite(SpriteRenderer* patch, FullFrameRenderer* fullFrame)
      : patch_(patch), fullFrame_(fullFrame) {}
  bool render(const CharacterState& state, uint16_t* frame);
  void invalidate();
  bool fullFrame() const;
  const char* error() const;

 private:
  SpriteRenderer* patch_;
  FullFrameRenderer* fullFrame_;
};
}
