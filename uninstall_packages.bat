@echo off
echo 正在卸载 miniaudio, Pillow, 和 pywin32...

REM 使用pip卸载这些包
E:\s\d\python3810\python.exe -m pip uninstall miniaudio Pillow pywin32 -y

if %errorlevel% neq 0 (
    echo pip卸载失败，正在尝试手动删除...

    REM 手动删除miniaudio相关文件
    if exist "E:\s\d\python3810\lib\site-packages\_miniaudio.pyd" del /f /q "E:\s\d\python3810\lib\site-packages\_miniaudio.pyd"
    if exist "E:\s\d\python3810\lib\site-packages\miniaudio.py" del /f /q "E:\s\d\python3810\lib\site-packages\miniaudio.py"
    if exist "E:\s\d\python3810\lib\site-packages\miniaudio-1.61.dist-info" rd /s /q "E:\s\d\python3810\lib\site-packages\miniaudio-1.61.dist-info"

    REM 手动删除Pillow相关文件
    if exist "E:\s\d\python3810\lib\site-packages\PIL" rd /s /q "E:\s\d\python3810\lib\site-packages\PIL"
    if exist "E:\s\d\python3810\lib\site-packages\pillow-10.4.0.dist-info" rd /s /q "E:\s\d\python3810\lib\site-packages\pillow-10.4.0.dist-info"

    REM 手动删除pywin32相关文件
    if exist "E:\s\d\python3810\lib\site-packages\PyWin32.chm" del /f /q "E:\s\d\python3810\lib\site-packages\PyWin32.chm"
    if exist "E:\s\d\python3810\lib\site-packages\pywin32.pth" del /f /q "E:\s\d\python3810\lib\site-packages\pywin32.pth"
    if exist "E:\s\d\python3810\lib\site-packages\pywin32.version.txt" del /f /q "E:\s\d\python3810\lib\site-packages\pywin32.version.txt"
    if exist "E:\s\d\python3810\lib\site-packages\pywin32_ctypes-0.2.3.dist-info" rd /s /q "E:\s\d\python3810\lib\site-packages\pywin32_ctypes-0.2.3.dist-info"
    if exist "E:\s\d\python3810\lib\site-packages\pywin32_system32" rd /s /q "E:\s\d\python3810\lib\site-packages\pywin32_system32"
    if exist "E:\s\d\python3810\lib\site-packages\pywin32-311.dist-info" rd /s /q "E:\s\d\python3810\lib\site-packages\pywin32-311.dist-info"
)

echo 卸载完成！
pause