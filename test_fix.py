
import os
import sys
import time

try:
    import miniaudio
    print("miniaudio imported successfully")
except ImportError:
    print("miniaudio not found")
    sys.exit(1)

file_path = r"e:\s\wol\py\q3\assets\1.mp3"

if not os.path.exists(file_path):
    print(f"File not found: {file_path}")
    sys.exit(1)

print(f"Testing file: {file_path}")
try:
    file_info = miniaudio.get_file_info(file_path)
    print(f"Duration: {file_info.duration}")
    print(f"Sample Rate: {file_info.sample_rate}")
    
    # Test decoding
    # print("Attempting decode_file...")
    # decoded = miniaudio.decode_file(file_path)
    # print(f"Decoded object dir: {dir(decoded)}")
    # print(f"Decoded samples length: {len(decoded.samples)}")
    # print(f"Decoded sample rate: {decoded.sample_rate}")
    # print(f"Decoded channels: {decoded.nchannels}")
    # print(f"Decoded sample_format: {decoded.sample_format} (type: {type(decoded.sample_format)})")
    
    # Try to convert int to Enum if needed
    # sf = decoded.sample_format
    # if isinstance(sf, int):
    #     try:
    #          sf = miniaudio.SampleFormat(sf)
    #          print(f"Converted to Enum: {sf}")
    #     except:
    #          print("Could not convert to Enum")

    # Test stream creation (Approach: Read file bytes, use stream_memory)
    print("Attempting stream_memory with file bytes...")
    with open(file_path, 'rb') as f:
        file_data = f.read()
    
    print(f"Read {len(file_data)} bytes")

    stream = miniaudio.stream_memory(
        file_data,
        output_format=miniaudio.SampleFormat.SIGNED16,
        nchannels=2,
        sample_rate=44100
    )
    print("Stream created successfully")
    
    # Test Device Init (might fail in CI/Server env)
    print("Attempting Device Init...")
    device = miniaudio.PlaybackDevice()
    print("Device initialized. Starting playback (simulated)...")
    device.start(stream)
    time.sleep(0.5)
    device.close()
    print("Playback finished without error.")

except Exception as e:
    print(f"ERROR: {e}")
    import traceback
    traceback.print_exc()
