import Foundation
import AVFoundation
import Speech

final class StudyBuddyDictation {
    private let audioEngine = AVAudioEngine()
    private var recognitionTask: SFSpeechRecognitionTask?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private let localeIdentifier: String
    private var stopped = false

    init(localeIdentifier: String) {
        self.localeIdentifier = localeIdentifier
    }

    private func emit(_ type: String, _ values: [String: Any] = [:]) {
        var payload = values
        payload["type"] = type
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let line = String(data: data, encoding: .utf8) else { return }
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }

    func requestAccessAndStart() {
        SFSpeechRecognizer.requestAuthorization { [weak self] speechStatus in
            guard let self else { return }
            guard speechStatus == .authorized else {
                self.emit("error", ["message": "Speech Recognition permission was not granted. Enable it in System Settings → Privacy & Security → Speech Recognition."])
                exit(2)
            }
            AVCaptureDevice.requestAccess(for: .audio) { microphoneGranted in
                DispatchQueue.main.async {
                    guard microphoneGranted else {
                        self.emit("error", ["message": "Microphone permission was not granted. Enable it in System Settings → Privacy & Security → Microphone."])
                        exit(3)
                    }
                    self.start()
                }
            }
        }
    }

    private func start() {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier)) else {
            emit("error", ["message": "Apple Speech does not support the selected language: \(localeIdentifier)."])
            exit(4)
        }
        guard recognizer.isAvailable else {
            emit("error", ["message": "Apple Speech is temporarily unavailable on this Mac."])
            exit(5)
        }
        guard recognizer.supportsOnDeviceRecognition else {
            emit("error", ["message": "The on-device speech model for \(localeIdentifier) is not installed. Add Dictation for this language in System Settings → Keyboard → Dictation."])
            exit(6)
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true
        request.taskHint = .dictation
        request.contextualStrings = ["StudyBuddy", "Buddy", "LaTeX", "flashcards", "cheat sheet"]
        recognitionRequest = request

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.channelCount > 0 && format.sampleRate > 0 else {
            emit("error", ["message": "No working microphone input was found."])
            exit(7)
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            emit("error", ["message": "Could not start the microphone: \(error.localizedDescription)"])
            exit(8)
        }

        emit("ready", ["locale": recognizer.locale.identifier, "onDevice": true])
        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self, !self.stopped else { return }
            if let result {
                self.emit(result.isFinal ? "final" : "partial", [
                    "text": result.bestTranscription.formattedString,
                    "isFinal": result.isFinal
                ])
                if result.isFinal { self.stop(exitCode: 0) }
            } else if let error {
                self.emit("error", ["message": error.localizedDescription])
                self.stop(exitCode: 9)
            }
        }
    }

    func stop(exitCode: Int32 = 0) {
        guard !stopped else { return }
        stopped = true
        if audioEngine.isRunning { audioEngine.stop() }
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionTask?.finish()
        emit("stopped")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { exit(exitCode) }
    }
}

let locale = CommandLine.arguments.dropFirst().first ?? Locale.current.identifier
let dictation = StudyBuddyDictation(localeIdentifier: locale)
signal(SIGINT, SIG_IGN)
let interruptSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
interruptSource.setEventHandler { dictation.stop() }
interruptSource.resume()
dictation.requestAccessAndStart()
RunLoop.main.run()
