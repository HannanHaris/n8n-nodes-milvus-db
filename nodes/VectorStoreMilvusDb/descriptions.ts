import type { INodeProperties } from 'n8n-workflow';

/**
 * Database selector. Milvus always has a `default` database; anything else has to
 * be created explicitly (client.createDatabase / RBAC). Listing requires the
 * credential user to have database-level read privileges.
 */
export const milvusDatabaseRLC: INodeProperties = {
	displayName: 'Milvus Database',
	name: 'milvusDatabase',
	type: 'resourceLocator',
	default: { mode: 'list', value: 'default' },
	required: true,
	description: 'The Milvus database to work in. Leave as "default" for single-database clusters.',
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: {
				searchListMethod: 'milvusDatabasesSearch',
				searchable: false,
			},
		},
		{
			displayName: 'By Name',
			name: 'id',
			type: 'string',
			placeholder: 'default',
		},
	],
};

/**
 * Collection selector, scoped to whatever database is selected above.
 *
 * `loadOptionsDependsOn` is what makes the collection list re-fetch when the user
 * changes the database. It belongs on the property's typeOptions — n8n's types
 * reject it inside a mode's typeOptions.
 */
export const milvusCollectionRLC: INodeProperties = {
	displayName: 'Milvus Collection',
	name: 'milvusCollection',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	required: true,
	typeOptions: {
		loadOptionsDependsOn: ['milvusDatabase.value'],
	},
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			typeOptions: {
				searchListMethod: 'milvusCollectionsSearch',
				searchable: true,
			},
		},
		{
			displayName: 'By Name',
			name: 'id',
			type: 'string',
		},
	],
};
