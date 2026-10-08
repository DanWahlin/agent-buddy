#include "../firmware/AgentCompanion/src/DeviceCommands.h"
#include "../firmware/AgentCompanion/src/OrientationSettings.h"
#include <cassert>
#include <iostream>
#include <string>

using namespace copilot;

static DeviceCommand send(DeviceCommands& parser, const std::string& text) {
  DeviceCommand result = DeviceCommand::None;
  for (char byte : text) result = parser.feed(byte, 0);
  return result;
}

int main() {
  static_assert(kDeviceProtocol == 13);
  DeviceCommands parser;
  for (DeviceCommand command : {DeviceCommand::Idle, DeviceCommand::Surprise, DeviceCommand::Working,
                                DeviceCommand::Complete, DeviceCommand::Attention}) {
    assert(send(parser, std::string("!") + commandName(command) + "\r\n") == command);
  }
  assert(send(parser, "s") == DeviceCommand::Capture);
  assert(send(parser, "h") == DeviceCommand::Heap);
  assert(send(parser, "i") == DeviceCommand::Info);
  assert(send(parser, "u") == DeviceCommand::UploadCharacter);
  assert(send(parser, "w") == DeviceCommand::ScanWifi);
  assert(send(parser, "o") == DeviceCommand::GetOrientation);
  assert(send(parser, "^-25\n") == DeviceCommand::ConfigureOrientation);
  int16_t offset;
  assert(parseOrientationOffset(parser.payload(), offset) && offset == -25);
  for (const char* invalid : {"", "-", "--5", "151", "-155", "3", "9999", "1.5", " 5", "+5"})
    assert(!parseOrientationOffset(invalid, offset));
  for (const char* valid : {"0", "5", "-5", "150", "-150"})
    assert(parseOrientationOffset(valid, offset));
  assert(send(parser, "^1.5\n") == DeviceCommand::Invalid);
  assert(send(parser, "^--5\n") == DeviceCommand::ConfigureOrientation);
  assert(!parseOrientationOffset(parser.payload(), offset));
  assert(send(parser, "@TXkgV2ktRmk=:cGFzc3dvcmQ=\n") == DeviceCommand::ConfigureWifi);
  assert(std::strcmp(parser.wifiPayload(), "TXkgV2ktRmk=:cGFzc3dvcmQ=") == 0);
  assert(send(parser, "@b3Blbg==:\n") == DeviceCommand::ConfigureWifi);
  const std::string mask(96, 'A');
  assert(send(parser, "%copilot:6F7CFF:" + mask + "\n") == DeviceCommand::DefineAgentIcon);
  assert(std::strcmp(parser.payload(), ("copilot:6F7CFF:" + mask).c_str()) == 0);
  assert(send(parser, "&copilot=w,claude=a,codex=c\n") == DeviceCommand::SetAgentBadges);
  assert(std::strcmp(parser.payload(), "copilot=w,claude=a,codex=c") == 0);
  assert(send(parser, "&\n") == DeviceCommand::SetAgentBadges);
  assert(std::strcmp(parser.payload(), "") == 0);
  assert(send(parser, "$AIC: 26,458|Tokens: 1.2M\n") == DeviceCommand::SetUsage);
  assert(std::strcmp(parser.payload(), "AIC: 26,458|Tokens: 1.2M") == 0);
  assert(send(parser, "$\n") == DeviceCommand::SetUsage);
  assert(std::strcmp(parser.payload(), "") == 0);
  assert(send(parser, "$AIC: <1>\n") == DeviceCommand::Invalid);
  assert(send(parser, "@invalid packet\n") == DeviceCommand::Invalid);
  assert(send(parser, "%copilot?:6F7CFF:" + mask + "\n") == DeviceCommand::Invalid);
  assert(send(parser, "&copilot=W\n") == DeviceCommand::Invalid);
  assert(send(parser, "\n") == DeviceCommand::None);
  assert(send(parser, "x") == DeviceCommand::Invalid);
  assert(send(parser, "!not-a-mode\n") == DeviceCommand::Invalid);
  assert(send(parser, "!" + std::string(100, 's') + "\n") == DeviceCommand::Invalid);
  assert(send(parser, "!working\n") == DeviceCommand::Working);
  assert(send(parser, "!att") == DeviceCommand::None);
  assert(parser.expire(999) == DeviceCommand::None);
  assert(parser.expire(1000) == DeviceCommand::Invalid);
  assert(send(parser, "!attention\n") == DeviceCommand::Attention);
  assert(send(parser, "%" + std::string(192, 'a') + "\n") == DeviceCommand::Invalid);
  std::cout << "PASS: bounded mode, Wi-Fi, badge and usage packets, legacy diagnostics, CRLF, overflow and timeout recovery\n";
}
