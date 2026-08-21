// ---------------------------------------------------------------------
// media.js
// Photo compression, and a VoiceRecorder class that records audio
// (MediaRecorder) while running the browser's live speech recognition
// in parallel, since the Web Speech API can only transcribe live
// microphone input — not a pre-recorded audio file. This means the
// transcript is captured *during* recording, not afterwards.
//
// IMPORTANT — iPhone Safari notes:
// - getUserMedia (microphone) and SpeechRecognition both require a
//   secure context: the app must be opened over https:// (or
//   http://localhost), NOT as a local file (file://). Opening the
//   file directly will make photo capture work (it uses the native
//   camera app) but voice recording/transcription will fail.
// - Even over https, Arabic speech recognition support varies by
//   iOS version and may be less reliable than English. The text area
//   is always editable so this is never a hard blocker.
// ---------------------------------------------------------------------

function compressImage(file, maxWidth = 1600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read-failed"));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error("image-failed"));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxWidth) {
          height = Math.round(height * (maxWidth / width));
          width = maxWidth;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("compress-failed"))),
          "image/jpeg",
          quality
        );
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

class VoiceRecorder {
  constructor() {
    this.mediaRecorder = null;
    this.chunks = [];
    this.stream = null;
    this.recognition = null;
    this.transcript = "";
    this.speechSupported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    this.onTick = null;
    this.timerInterval = null;
    this.seconds = 0;
  }

  // Throws if microphone permission is denied or unavailable.
  async start(lang) {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    const mimeType = MediaRecorder.isTypeSupported("audio/mp4")
      ? "audio/mp4"
      : MediaRecorder.isTypeSupported("audio/webm")
      ? "audio/webm"
      : "";
    this.mediaRecorder = mimeType
      ? new MediaRecorder(this.stream, { mimeType })
      : new MediaRecorder(this.stream);

    this.chunks = [];
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.mediaRecorder.start();

    this.seconds = 0;
    this.timerInterval = setInterval(() => {
      this.seconds++;
      if (this.onTick) this.onTick(this.seconds);
    }, 1000);

    this.transcript = "";
    if (this.speechSupported) {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      this.recognition = new SR();
      this.recognition.lang = lang === "ar" ? "ar-SA" : "en-US";
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.onresult = (event) => {
        let text = "";
        for (let i = 0; i < event.results.length; i++) {
          text += event.results[i][0].transcript;
        }
        this.transcript = text;
      };
      this.recognition.onerror = (e) => console.warn("speech recognition:", e.error);
      try {
        this.recognition.start();
      } catch (err) {
        console.warn(err);
      }
    }
  }

  stop() {
    return new Promise((resolve) => {
      clearInterval(this.timerInterval);
      if (this.recognition) {
        try { this.recognition.stop(); } catch (e) { /* ignore */ }
      }
      if (!this.mediaRecorder) {
        resolve({ blob: null, transcript: this.transcript });
        return;
      }
      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mediaRecorder.mimeType || "audio/webm" });
        if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
        resolve({ blob, transcript: this.transcript.trim() });
      };
      this.mediaRecorder.stop();
    });
  }
}
