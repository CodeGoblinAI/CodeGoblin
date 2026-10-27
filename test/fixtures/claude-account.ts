import readline from "node:readline"
const mode=process.argv[2]
for await (const line of readline.createInterface({input:process.stdin})) {
  const packet=JSON.parse(line)
  if(packet.type!=="control_request") continue
  if(mode==="native") {console.log(JSON.stringify({type:"control_request",request_id:"tool",request:{subtype:"can_use_tool"}}));continue}
  if(mode==="hang") continue
  const value=packet.request.subtype==="initialize" ? {} : {rate_limits_available:true,rate_limits:{five_hour:{utilization:25,resets_at:"2026-10-05T00:00:00Z"},seven_day:{utilization:0,resets_at:null}},secret:"NEVER_CACHE",behaviors:{private:"NEVER_CACHE"}}
  if(packet.request.subtype==="get_usage" && packet.request.skip_behaviors!==true) process.exit(2)
  console.log(JSON.stringify({type:"control_response",response:{subtype:mode==="unsupported"?"error":"success",request_id:packet.request_id,response:value,error:"SECRET_ERROR"}}))
}
