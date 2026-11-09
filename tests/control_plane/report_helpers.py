"""Consume and acknowledge the real bounded wire protocol in Runner tests."""
import asyncio
import gzip
from runner import generated as protocol

async def receive_report(client):
    results = []
    while True:
        message = await asyncio.wait_for(client._outgoing.get(), 3)
        if message.HasField("validation_status_notice"):
            return message.validation_status_notice
        if not message.HasField("validation_report_chunk"):
            continue
        chunk = message.validation_report_chunk
        decoded = protocol.ValidationResult.FromString(gzip.decompress(chunk.gzip_result))
        results.extend(decoded.results)
        await client._handle(protocol.ControllerMessage(validation_report_chunk_ack=protocol.ValidationReportChunkAck(
            run_id=chunk.run_id, upload_id=chunk.upload_id, sequence=chunk.sequence)))
        if chunk.final:
            decoded.results.extend(results)
            return decoded
