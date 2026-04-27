@echo off
setlocal

python -m pip install -r requirements.txt
python -m pip install pyinstaller

pyinstaller --noconfirm --onefile --windowed --name pico app.py

echo.
echo Build completado. Ejecutable en dist\pico.exe
endlocal
