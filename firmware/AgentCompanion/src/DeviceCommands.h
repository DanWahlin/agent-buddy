#pragma once
#include <cstdint>
#include <cstring>
#include <initializer_list>

namespace copilot {
enum class DeviceCommand {
  None, Invalid, Capture, Heap, Info, UploadCharacter, ConfigureWifi, ScanWifi,
  DefineAgentIcon, SetAgentBadges, SetUsage, Idle, Surprise, Working, Complete, Attention
};
constexpr unsigned kDeviceProtocol = 11;

inline const char* commandName(DeviceCommand command) {
  switch (command) {
    case DeviceCommand::Idle: return "idle";
    case DeviceCommand::Surprise: return "surprise";
    case DeviceCommand::Working: return "working";
    case DeviceCommand::Complete: return "complete";
    case DeviceCommand::Attention: return "attention";
    default: return "invalid";
  }
}

class DeviceCommands {
 public:
  DeviceCommand feed(char byte, uint64_t milliseconds) {
    if (!receiving_) {
      if (byte == '!') {
        receiving_ = true;
        packet_ = Packet::Mode;
        length_ = 0;
        invalid_ = false;
        previous_ = milliseconds;
        return DeviceCommand::None;
      }
      if (byte == '@') {
        receiving_ = true;
        packet_ = Packet::Wifi;
        length_ = 0;
        invalid_ = false;
        previous_ = milliseconds;
        return DeviceCommand::None;
      }
      if (byte == '%') {
        receiving_ = true;
        packet_ = Packet::Icon;
        length_ = 0;
        invalid_ = false;
        previous_ = milliseconds;
        return DeviceCommand::None;
      }
      if (byte == '&') {
        receiving_ = true;
        packet_ = Packet::Agents;
        length_ = 0;
        invalid_ = false;
        previous_ = milliseconds;
        return DeviceCommand::None;
      }
      if (byte == '$') {
        receiving_ = true;
        packet_ = Packet::Usage;
        length_ = 0;
        invalid_ = false;
        previous_ = milliseconds;
        return DeviceCommand::None;
      }
      if (byte == 's') return DeviceCommand::Capture;
      if (byte == 'h') return DeviceCommand::Heap;
      if (byte == 'i') return DeviceCommand::Info;
      if (byte == 'u') return DeviceCommand::UploadCharacter;
      if (byte == 'w') return DeviceCommand::ScanWifi;
      return byte == '\r' || byte == '\n' ? DeviceCommand::None : DeviceCommand::Invalid;
    }
    previous_ = milliseconds;
    if (byte == '\n') {
      receiving_ = false;
      if (invalid_) return DeviceCommand::Invalid;
      text_[length_] = '\0';
      if (packet_ == Packet::Wifi) return DeviceCommand::ConfigureWifi;
      if (packet_ == Packet::Icon) return DeviceCommand::DefineAgentIcon;
      if (packet_ == Packet::Agents) return DeviceCommand::SetAgentBadges;
      if (packet_ == Packet::Usage) return DeviceCommand::SetUsage;
      for (DeviceCommand command : {DeviceCommand::Idle, DeviceCommand::Surprise, DeviceCommand::Working,
                                     DeviceCommand::Complete, DeviceCommand::Attention}) {
        if (std::strcmp(text_, commandName(command)) == 0) return command;
      }
      return DeviceCommand::Invalid;
    }
    if (byte == '\r') return DeviceCommand::None;
    const bool alphaNum = (byte >= 'a' && byte <= 'z') || (byte >= 'A' && byte <= 'Z')
        || (byte >= '0' && byte <= '9');
    bool allowed = byte >= 'a' && byte <= 'z';
    if (packet_ == Packet::Wifi || packet_ == Packet::Icon)
      allowed = alphaNum || byte == '+' || byte == '/' || byte == '=' || byte == ':' || byte == '-';
    else if (packet_ == Packet::Agents)
      allowed = (byte >= 'a' && byte <= 'z') || (byte >= '0' && byte <= '9')
          || byte == '-' || byte == '=' || byte == ',';
    else if (packet_ == Packet::Usage)
      allowed = alphaNum || byte == ' ' || byte == ',' || byte == '.' || byte == ':' || byte == '|';
    if (invalid_ || length_ == sizeof(text_) - 1 || !allowed) invalid_ = true;
    else text_[length_++] = byte;
    return DeviceCommand::None;
  }

  DeviceCommand expire(uint64_t milliseconds) {
    if (!receiving_ || milliseconds - previous_ < 1000) return DeviceCommand::None;
    receiving_ = false;
    return DeviceCommand::Invalid;
  }

  const char* payload() const { return text_; }
  const char* wifiPayload() const { return text_; }

 private:
  enum class Packet : uint8_t { Mode, Wifi, Icon, Agents, Usage };
  char text_[192] = {};
  unsigned length_ = 0;
  uint64_t previous_ = 0;
  bool receiving_ = false, invalid_ = false;
  Packet packet_ = Packet::Mode;
};
}
