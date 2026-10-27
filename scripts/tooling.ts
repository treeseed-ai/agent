import {SourcePolicy} from '@treeseed-cordis/sdk/source-policy';
class AgentTooling {static run():void{new SourcePolicy().check(process.cwd(),process.argv[2]==='build');}}
AgentTooling.run();
