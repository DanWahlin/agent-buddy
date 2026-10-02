#include "CharacterFrame.h"
#include "SpriteStorage.h"

namespace copilot {
bool applyModeRequest(CharacterMotion& motion, const ModeRequest& request) {
  if (request.mode == CharacterMode::Surprise) {
    if (request.returnToIdle) motion.surpriseToIdle();
    else motion.surprise();
  } else if (!motion.setMode(request.mode)) {
    return false;
  }
  return motion.error() == nullptr;
}

void stepCharacterMotion(CharacterMotion& motion, double seconds) {
  motion.update(seconds * characterPack()->header.motionSpeed);
}

bool CharacterSprite::fullFrame() const {
  return characterPack()->header.layout == PackLayout::FullFrame;
}

bool CharacterSprite::render(const CharacterState& state, uint16_t* frame) {
  return fullFrame() ? fullFrame_->render(state.pose, state.effectSeconds, frame)
                     : patch_->render(state.pose, frame);
}

void CharacterSprite::invalidate() {
  if (patch_) patch_->invalidate();
  if (fullFrame_) fullFrame_->invalidate();
}

const char* CharacterSprite::error() const {
  return fullFrame() ? fullFrame_->error() : patch_->error();
}
}
