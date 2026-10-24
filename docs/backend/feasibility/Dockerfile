# B01-PoC: wegwerfbares Prüfimage, kein Produktimage.
FROM python:3.13-slim-trixie@sha256:57b29a7c050c4e679e4bea572e14b3965cf4b5839de2da49d55e49ffc4024f39

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --require-hashes --only-binary=:all: --no-deps -r /tmp/requirements.txt \
 && useradd --create-home --uid 10001 poc
WORKDIR /poc
COPY env_info.py images_poc.py pdf_poc.py /poc/
USER 10001:10001
ENV POC_OUT=/out
CMD ["sh", "-c", "python -I env_info.py && python -I images_poc.py && python -I pdf_poc.py"]
