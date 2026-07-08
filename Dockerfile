FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir \
    google-cloud-bigquery \
    google-auth \
    google-api-python-client

# 🎯 소스 파일 및 설정만 선택적 복사 (도커 이미지 경량화 및 불필요 파일 업로드 방지)
COPY config.yaml /app/config.yaml
COPY src/ /app/src/

EXPOSE 8080

CMD ["python3", "-u", "src/backend_server.py"]
