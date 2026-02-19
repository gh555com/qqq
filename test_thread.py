import threading
import time
import sys

def worker(name):
    print(f"Worker {name} starting", flush=True)
    for i in range(3):
        print(f"Worker {name}: {i}", flush=True)
        time.sleep(0.5)
    print(f"Worker {name} done", flush=True)

print("Main: starting threads", flush=True)
t1 = threading.Thread(target=worker, args=("A",))
t2 = threading.Thread(target=worker, args=("B",))

t1.start()
print(f"Main: t1 started, alive={t1.is_alive()}", flush=True)
t2.start()
print(f"Main: t2 started, alive={t2.is_alive()}", flush=True)

t1.join()
t2.join()
print("Main: all done", flush=True)
