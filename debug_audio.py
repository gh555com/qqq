import miniaudio
import time
import os
import sys

def test_playback(file_path):
    print(f"Testing playback for: {file_path}")
    if not os.path.exists(file_path):
        print("File not found!")
        return

    try:
        file_info = miniaudio.get_file_info(file_path)
        print(f"File Info: {file_info}")
    except Exception as e:
        print(f"Failed to get file info: {e}")
        return

    try:
        stream = miniaudio.stream_file(file_path)
        with miniaudio.PlaybackDevice() as device:
            print(f"Device initialized.")
            device.start(stream)
            print("Playback started...")
            time.sleep(2) # Play for enough time
            print("Playback finished.")
    except Exception as e:
        print(f"Playback failed: {e}")

if __name__ == "__main__":
    # Adjust path to where the user's asset is likely to be
    target_file = r"e:\s\wol\py\q3\assets\kope\2.mp3"
    test_playback(target_file)
