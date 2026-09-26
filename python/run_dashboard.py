import uvicorn
uvicorn.run("dashboard.app:app", host="0.0.0.0", port=8766, log_level="warning", reload=False)
