FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATA_DIR=/data

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && groupadd --system --gid 10001 tempchat \
    && useradd --system --uid 10001 --gid tempchat --no-create-home tempchat \
    && install -d -o tempchat -g tempchat /data
COPY server.py assets.py schema.sql ./
COPY web/ ./web/

USER tempchat
EXPOSE 3087
CMD ["gunicorn", "--bind", "0.0.0.0:3087", "--workers", "1", "--worker-class", "gthread", "--threads", "8", "--timeout", "90", "server:create()"]
