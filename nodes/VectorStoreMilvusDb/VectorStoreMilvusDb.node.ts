/*
 * Milvus Vector Store (Database)
 * n8n community node: Milvus vector store with explicit database selection.
 */
import { Milvus } from '@langchain/community/vectorstores/milvus';
import { createVectorStoreNode } from '@n8n/ai-utilities';
import type { Embeddings } from '@langchain/core/embeddings';
import type { IExecuteFunctions, INodeProperties, ISupplyDataFunctions } from 'n8n-workflow';

import { milvusCollectionRLC, milvusDatabaseRLC } from './descriptions';
import {
	createMilvusClient,
	milvusCollectionsSearch,
	milvusDatabasesSearch,
	type MilvusCredentials,
} from './listSearch';

const sharedFields: INodeProperties[] = [milvusDatabaseRLC, milvusCollectionRLC];

const insertFields: INodeProperties[] = [
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		options: [
			{
				displayName: 'Clear Collection',
				name: 'clearCollection',
				type: 'boolean',
				default: false,
				description: 'Whether to drop the collection before inserting new data',
			},
		],
	},
];

type Context = IExecuteFunctions | ISupplyDataFunctions;

/**
 * Resolves credential + database + collection into the args LangChain's Milvus wants.
 *
 * The Milvus constructor spreads `clientConfig` first and then overrides
 * address/username/password from the top-level fields, so `database` set inside
 * clientConfig survives and is what pins the connection to the right db.
 */
async function resolveConfig(context: Context, itemIndex: number) {
	const credentials = (await context.getCredentials('milvusApi')) as unknown as MilvusCredentials;

	const database =
		(context.getNodeParameter('milvusDatabase', itemIndex, 'default', {
			extractValue: true,
		}) as string) || 'default';

	const collection = context.getNodeParameter('milvusCollection', itemIndex, '', {
		extractValue: true,
	}) as string;

	return {
		credentials,
		database,
		collection,
		config: {
			url: credentials.baseUrl,
			username: credentials.username,
			password: credentials.password,
			collectionName: collection,
			clientConfig: {
				address: credentials.baseUrl,
				username: credentials.username,
				password: credentials.password,
				database,
			},
		},
	};
}

export class VectorStoreMilvusDb extends createVectorStoreNode<Milvus>({
	meta: {
		displayName: 'Milvus Vector Store (Database)',
		name: 'vectorStoreMilvusDb',
		description: 'Work with your data in Milvus, with explicit database selection',
		icon: { light: 'file:milvusdb.svg', dark: 'file:milvusdb.svg' },
		docsUrl:
			'https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.vectorstoremilvus/',
		credentials: [
			{
				name: 'milvusApi',
				required: true,
			},
		],
		operationModes: ['load', 'insert', 'retrieve', 'retrieve-as-tool'],
	},
	methods: {
		listSearch: {
			milvusDatabasesSearch,
			milvusCollectionsSearch,
		},
	},
	sharedFields,
	insertFields,

	async getVectorStoreClient(context, _filter, embeddings: Embeddings, itemIndex: number) {
		const { config } = await resolveConfig(context, itemIndex);
		return await Milvus.fromExistingCollection(embeddings, config);
	},

	async populateVectorStore(context, embeddings: Embeddings, documents, itemIndex: number) {
		const { credentials, database, collection, config } = await resolveConfig(context, itemIndex);
		const options = context.getNodeParameter('options', itemIndex, {}) as {
			clearCollection?: boolean;
		};

		if (options.clearCollection) {
			const client = createMilvusClient(credentials, database);
			try {
				await client.dropCollection({ collection_name: collection });
			} finally {
				await client.closeConnection();
			}
		}

		await Milvus.fromDocuments(documents, embeddings, config);
	},
}) {
	constructor() {
		super();
		// n8n's community-node installer stores a node's version in an INTEGER
		// database column. The vector-store base assigns a fractional version
		// ([1, 1.1, 1.2, 1.3]), so installing via the UI fails on PostgreSQL with
		// "invalid input syntax for type integer: 1.3" (n8n issue #23456).
		// Overriding to the single integer 2 makes the installer accept it while
		// preserving identical field visibility: Embedding Batch Size (@version
		// >= 1.1) stays shown, and the legacy tool-name field (@version <= 1.2)
		// stays hidden — exactly as at 1.3.
		this.description.version = 2;
	}
}
