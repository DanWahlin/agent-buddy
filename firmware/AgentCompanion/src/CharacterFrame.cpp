#include "CharacterFrame.h"
#include "SpriteStorage.h"

namespace copilot {
bool applyModeRequest(CharacterMotion& motion, const ModeRequest& request) {
  if (request.mode == CharacterMode::Surprise) {
    motion.surprise();
  } else if (!motion.setMode(request.mode)) {
    return false;
  }
  return motion.error() == nullptr;
}

void stepCharacterMotion(CharacterMotion& motion, double seconds, const PackHeader& pack) {
  motion.update(seconds * pack.motionSpeed);
}

bool CharacterSprite::fullFrame() const {
  const CharacterPack* pack = characterPack();
  return pack && pack->header.layout == PackLayout::FullFrame;
}

bool CharacterSprite::render(const CharacterState& state, uint16_t* frame) {
  if (fullFrame()) return fullFrame_->render(state.pose, state.effectSeconds, frame);
  SpritePose pose = state.pose;
  if (const CharacterPack* pack = characterPack())
    pose.index = walkIndex(pack->header, pose.direction, pose.index, state.effectSeconds);
  return patch_->render(pose, frame);
}

void CharacterSprite::invalidate() {
  if (patch_) patch_->invalidate();
  if (fullFrame_) fullFrame_->invalidate();
}

const char* CharacterSprite::error() const {
  if (!characterPack()) return "The character pack is not mapped.";
  return fullFrame() ? fullFrame_->error() : patch_->error();
}
}
