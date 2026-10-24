import {sniffImage} from '../image/sniff';
import {ImageProcessingError, type ProbeResult} from '../image/types';
/** Header-only preflight with server limits, independent of browser decoders. */
export async function probeServerImage(file: File, limits: {maxFileBytes:number;maxPixels:number;maxEdge:number}): Promise<ProbeResult> {
  if(file.size>limits.maxFileBytes)throw new ImageProcessingError('file-too-large','Input limit');
  let header=sniffImage(new Uint8Array(await file.slice(0,128*1024).arrayBuffer()));
  if(!header)throw new ImageProcessingError('unsupported-type','Signature');
  if(!header.complete&&file.size>128*1024)header=sniffImage(new Uint8Array(await file.arrayBuffer()))??header;
  if(header.animated)throw new ImageProcessingError('animated-unsupported','Animation');
  if(!header.width||!header.height)throw new ImageProcessingError('decode-failed','Header');
  const swap=header.orientation>=5&&header.orientation<=8;
  const width=swap?header.height:header.width,height=swap?header.width:header.height;
  if(width>limits.maxEdge||height>limits.maxEdge||width*height>limits.maxPixels)throw new ImageProcessingError('dimensions-too-large','Dimensions');
  return {format:header.format,width,height,orientation:header.orientation,mayHaveTransparency:header.mayHaveTransparency};
}
