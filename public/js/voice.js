// ── Sidebar Voice Input ──

function initVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    document.getElementById('btn-mic').style.display = 'none';
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = (e) => {
    // Rebuild full transcript from all results every time
    let final = '';
    let interim = '';
    for (let i = 0; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        final += e.results[i][0].transcript;
      } else {
        interim += e.results[i][0].transcript;
      }
    }
    const input = document.getElementById('comment-input');
    const sep = textBeforeRecording ? textBeforeRecording + ' ' : '';
    const cleaned = punctuate(final);
    input.value = sep + cleaned + (interim ? ' ' + interim : '');
    input.scrollTop = input.scrollHeight;

    document.getElementById('voice-status').textContent = interim ? 'Listening...' : 'Processing...';
  };

  recognition.onend = () => {
    if (isRecording) {
      // Preserve accumulated text before restarting
      textBeforeRecording = document.getElementById('comment-input').value.trim();
      recognition.start();
      return;
    }
    textBeforeRecording = '';
    document.getElementById('voice-status').textContent = '';
    document.getElementById('voice-status').classList.remove('recording');
    document.getElementById('btn-mic').classList.remove('recording');
  };

  recognition.onerror = (e) => {
    if (e.error === 'no-speech') return; // Ignore, will auto-restart
    console.error('Speech error:', e.error);
    stopRecording();
    document.getElementById('voice-status').textContent = 'Error: ' + e.error;
  };
}

async function startRecording() {
  if (!recognition) return;
  isRecording = true;
  lastAudioFilename = null;
  audioChunks = [];
  textBeforeRecording = document.getElementById('comment-input').value.trim();
  recognition.start();

  // Start audio capture in parallel
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      if (audioChunks.length === 0) return;
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const file = onlyFiles()[currentIndex];
      if (!file) return;
      // Upload audio
      const res = await fetch(`/api/files/${encodeURIComponent(file.path)}/audio`, {
        method: 'POST',
        body: blob,
      });
      const data = await res.json();
      lastAudioFilename = data.audioFilename;
    };
    mediaRecorder.start();
  } catch (e) {
    console.warn('Audio capture unavailable:', e);
  }

  document.getElementById('btn-mic').classList.add('recording');
  document.getElementById('voice-status').textContent = 'Listening...';
  document.getElementById('voice-status').classList.add('recording');
}

function stopRecording() {
  if (!recognition) return;
  isRecording = false;
  recognition.stop();

  // Stop audio capture
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }

  // Let user review transcription and submit manually
}

function toggleRecording() {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

// ── Chat Voice Input ──

function initChatVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    document.getElementById('chat-mic').style.display = 'none';
    return;
  }

  chatRecognition = new SpeechRecognition();
  chatRecognition.continuous = true;
  chatRecognition.interimResults = true;
  chatRecognition.lang = 'en-US';

  chatRecognition.onresult = (e) => {
    let final = '';
    let interim = '';
    for (let i = 0; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        final += e.results[i][0].transcript;
      } else {
        interim += e.results[i][0].transcript;
      }
    }
    const input = document.getElementById('chat-input');
    const sep = chatTextBeforeRecording ? chatTextBeforeRecording + ' ' : '';
    const cleaned = typeof punctuate === 'function' ? punctuate(final) : final;
    input.value = sep + cleaned + (interim ? ' ' + interim : '');
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
  };

  chatRecognition.onend = () => {
    if (chatIsRecording) {
      // Preserve accumulated text before restarting
      chatTextBeforeRecording = document.getElementById('chat-input').value.trim();
      chatRecognition.start();
      return;
    }
    chatTextBeforeRecording = '';
    document.getElementById('chat-mic').classList.remove('recording');
  };

  chatRecognition.onerror = (e) => {
    if (e.error === 'no-speech') return;
    console.error('Chat speech error:', e.error);
    stopChatRecording();
  };
}

function startChatRecording() {
  if (!chatRecognition) return;
  chatIsRecording = true;
  chatTextBeforeRecording = document.getElementById('chat-input').value.trim();
  chatRecognition.start();
  document.getElementById('chat-mic').classList.add('recording');
}

function stopChatRecording(autoSend = false) {
  if (!chatRecognition) return;
  chatIsRecording = false;
  chatRecognition.stop();
  document.getElementById('chat-mic').classList.remove('recording');
  if (autoSend) {
    setTimeout(() => {
      const input = document.getElementById('chat-input');
      const text = input.value.trim();
      if (text) {
        input.value = '';
        sendChatMessage(text);
      }
    }, 400);
  }
}

function toggleChatRecording() {
  if (chatIsRecording) {
    stopChatRecording(false); // let user review and send manually
  } else {
    startChatRecording();
  }
}
