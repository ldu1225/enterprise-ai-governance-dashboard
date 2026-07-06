FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir \
    google-cloud-bigquery \
    google-auth \
    google-api-python-client

COPY . /app

EXPOSE 8080

CMD ["python3", "backend_server.py"]
