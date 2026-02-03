const videoEl = document.getElementById("camera-viewport");

const startCamera = async () => {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.error("Camera API not supported in this browser.");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 320 },
        height: { ideal: 240 },
        facingMode: "user",
      },
      audio: false,
    });

    videoEl.srcObject = stream;
    await videoEl.play();
  } catch (error) {
    console.error("Unable to access the camera:", error);
  }
};

startCamera();
