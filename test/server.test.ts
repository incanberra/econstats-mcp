import {expect,test} from 'bun:test';
import {resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('SDK delivers methodology instructions and exposes valid public data schemas without upstream requests',async()=>{
  const transport=new StdioClientTransport({command:process.execPath,args:['run',resolve(import.meta.dir,'../src/index.ts')],env:{MCP_PORT:'0',PORT:'0',PREFETCH_HOT_SERIES:'false',ECONSTATS_DISK_CACHE:'false'},stderr:'pipe'});
  const c=new Client({name:'schema-regression',version:'1.0'});
  try{
    await c.connect(transport);expect(c.getServerVersion()?.version).toBe('3.1.0');expect(c.getInstructions()).toContain('SOURCE ROUTING');
    expect(c.getInstructions()).not.toContain('Quarterly figures are annualized');
    expect(c.getInstructions()).not.toContain('BLS data values are index levels');
    expect(c.getInstructions()).toContain('quarterly growth is not universally annualized');
    const {tools}=await c.listTools();expect(tools.length).toBe(35);
    expect(tools.find(t=>t.name==='comtrade_get_data')!.inputSchema.required).toContain('reporter_code');
    expect(tools.find(t=>t.name==='comtrade_get_data')!.inputSchema.properties).toHaveProperty('fresh');
    const eia=tools.find(t=>t.name==='eia_get_data')!;expect(eia.inputSchema.properties).toHaveProperty('route');expect(eia.inputSchema.properties).toHaveProperty('fresh');expect(eia.inputSchema.required).toContain('route');expect(eia.inputSchema.properties).not.toHaveProperty('oute');
    expect(tools.find(t=>t.name==='abs_get_data')!.inputSchema.properties).toHaveProperty('series_key');expect(tools.find(t=>t.name==='revision_history')!.inputSchema.required).toContain('series_id');
    // Wildcard rejection must occur locally, with no credentials or upstream access.
    const r=await c.callTool({name:'worldbank_get_data',arguments:{country_codes:['*'],indicator:'SP.POP.TOTL'}});expect(r.isError).toBe(true);
  }finally{await c.close();}
},15000);
